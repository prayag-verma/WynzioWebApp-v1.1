/**
 * WebSocket Signaling Service for Wynzio
 * Handles real-time communication between Windows clients and web dashboard
 */
const socketIo = require('socket.io');
const deviceManager = require('../api/services/deviceManager');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const config = require('../config/app');

// Constants
const DEVICE_DATA_DIR = path.join(__dirname, '../data/devices');
const CLIENT_TIMEOUT = 30000; // 30 seconds
const HEARTBEAT_INTERVAL = 25000; // 25 seconds - matching Windows app default
const RECONNECT_BASE_DELAY = 2000; // Base delay for exponential backoff (ms)
const MAX_RECONNECT_ATTEMPTS = 5; // Match Windows app setting

// Create data directory if it doesn't exist
if (!fs.existsSync(DEVICE_DATA_DIR)) {
  fs.mkdirSync(DEVICE_DATA_DIR, { recursive: true });
}

// Singleton instance
let instance = null;

class SignalingService {
  constructor() {
    // Store active connections
    this.activeConnections = new Map();
    // Store connection timestamps for health monitoring
    this.connectionTimestamps = new Map();
    // Store reconnection attempts
    this.reconnectAttempts = new Map();
    // Store io instance
    this.io = null;
    // Monitoring interval ID
    this.monitorIntervalId = null;
    // Store pending reconnection timers
    this.reconnectTimers = new Map();
  }

  /**
   * Initialize WebSocket server
   * @param {Object} server - HTTP server instance
   * @return {Object} Socket.IO instance
   */
  initialize(server) {
    this.io = socketIo(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      pingTimeout: 10000,
      pingInterval: 5000,
      // Allow transport polling and websocket to match Windows app
      transports: ['polling', 'websocket'],
      // Make Socket.IO format compatible with Windows app
      allowEIO3: true,
      // Path must match Windows app
      path: '/socket.io'
    });

    // Authentication middleware
    this.io.use(require('./middleware/socketAuth'));

    // Connection handler
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    // Start health monitoring
    this.startMonitoring();

    logger.info('WebSocket signaling service initialized');
    return this.io;
  }

  /**
   * Start monitoring connections
   */
  startMonitoring() {
    // Clear any existing monitoring interval
    if (this.monitorIntervalId) {
      clearInterval(this.monitorIntervalId);
    }
    
    // Start new monitoring interval - align with Windows app expectation
    this.monitorIntervalId = setInterval(() => this.monitorConnections(), 15000);
    logger.info('Connection monitoring started');
  }

  /**
   * Stop monitoring connections
   */
  stopMonitoring() {
    if (this.monitorIntervalId) {
      clearInterval(this.monitorIntervalId);
      this.monitorIntervalId = null;
    }
    logger.info('Connection monitoring stopped');
  }

  /**
   * Handle new socket connection
   * @param {Object} socket - Socket instance
   */
  handleConnection(socket) {
    // Check for both clientId and hostId to support Windows app format
    const clientId = socket.handshake.query.clientId || socket.handshake.query.hostId || socket.id;
    // Check for client type - Windows app may not send this explicitly
    const clientType = socket.handshake.query.type || 
                      (socket.handshake.query.hostId ? 'device' : 
                      (socket.handshake.query.clientId ? 'dashboard' : 'unknown'));

    logger.info(`New ${clientType} connection: ${clientId}`);
    
    // Reset reconnection attempts on successful connection
    this.reconnectAttempts.set(clientId, 0);
    
    // Clear any pending reconnect timer
    if (this.reconnectTimers.has(clientId)) {
      clearTimeout(this.reconnectTimers.get(clientId));
      this.reconnectTimers.delete(clientId);
    }
    
    // Handle device client (Windows app)
    if (clientType === 'device') {
      this.handleDeviceConnection(socket, clientId);
    } 
    // Handle web dashboard client
    else if (clientType === 'dashboard') {
      this.handleDashboardConnection(socket, clientId);
    }

    // Generic disconnect handler
    socket.on('disconnect', (reason) => {
      logger.info(`Client disconnected: ${clientId}, reason: ${reason}`);
      this.activeConnections.delete(clientId);
      
      // Update status for devices
      if (clientType === 'device') {
        deviceManager.updateDeviceStatus(clientId, 'offline')
          .then(() => {
            this.io.emit('device-status-update', {
              deviceId: clientId,
              status: 'offline',
              timestamp: new Date().toISOString(),
              reason: reason
            });
          })
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
          
        // Schedule reconnection attempt if not an intentional disconnect
        if (reason !== 'client namespace disconnect' && reason !== 'io server disconnect') {
          this.scheduleReconnection(clientId, clientType);
        }
      }
    });

    // Error handler
    socket.on('error', (error) => {
      logger.error(`Socket error for ${clientId}:`, error);
    });
    
    // Handle reconnect events
    socket.on('reconnect', (attemptNumber) => {
      logger.info(`Client ${clientId} reconnected after ${attemptNumber} attempts`);
      
      // Reset reconnection attempts
      this.reconnectAttempts.set(clientId, 0);
      
      // Update device status if reconnected
      if (clientType === 'device') {
        deviceManager.updateDeviceStatus(clientId, 'online')
          .then(() => {
            this.io.emit('device-status-update', {
              deviceId: clientId,
              status: 'online',
              timestamp: new Date().toISOString()
            });
          })
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
      }
    });
    
    // Handle explicit reconnection failure
    socket.on('reconnect_failed', () => {
      logger.warn(`Client ${clientId} failed to reconnect after max attempts`);
      
      // Mark device as offline if it's a device
      if (clientType === 'device') {
        deviceManager.updateDeviceStatus(clientId, 'offline')
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
      }
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   * @param {String} clientId - Client identifier
   * @param {String} clientType - Client type ('device' or 'dashboard')
   */
  scheduleReconnection(clientId, clientType) {
    // Only schedule reconnection for devices
    if (clientType !== 'device') return;
    
    // Get current attempt count
    let attempts = this.reconnectAttempts.get(clientId) || 0;
    
    // Stop after max attempts
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn(`Maximum reconnection attempts reached for ${clientId}`);
      return;
    }
    
    // Calculate delay with exponential backoff (2^attempt seconds)
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempts);
    logger.info(`Scheduling reconnection for ${clientId} in ${delay}ms (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
    
    // Schedule reconnection
    const timer = setTimeout(() => {
      // Increment attempt counter
      this.reconnectAttempts.set(clientId, attempts + 1);
      
      // Try to reconnect by notifying all clients about an offline device
      // that might be trying to reconnect
      this.io.emit('reconnect-attempt', {
        deviceId: clientId,
        attempt: attempts + 1,
        timestamp: new Date().toISOString()
      });
      
      // Schedule next attempt if not max attempts
      if (attempts + 1 < MAX_RECONNECT_ATTEMPTS) {
        this.scheduleReconnection(clientId, clientType);
      }
    }, delay);
    
    // Store the timer
    this.reconnectTimers.set(clientId, timer);
  }

  /**
   * Handle device client connection (Windows app)
   * @param {Object} socket - Socket instance
   * @param {String} deviceId - Device identifier
   */
  handleDeviceConnection(socket, deviceId) {
    // Store connection
    this.activeConnections.set(deviceId, socket);
    this.connectionTimestamps.set(deviceId, Date.now());

    // Auto-register handler - matches Windows app SignalingService.cs format exactly
    socket.on('auto-register', async (deviceInfo) => {
      try {
        // Handle both formats: array format from socket.io.emit('event', [eventName, data]) 
        // or direct object from socket.io.emit('event', data)
        let data;
        if (Array.isArray(deviceInfo) && deviceInfo.length > 0) {
          // If it's an array, check if first element is the event name
          if (typeof deviceInfo[0] === 'string' && deviceInfo[0] === 'auto-register' && deviceInfo.length > 1) {
            data = deviceInfo[1]; // Use second element as data
          } else {
            data = deviceInfo[0]; // Use first element as data
          }
        } else {
          data = deviceInfo; // Use directly as data
        }
        
        logger.debug(`Auto-register request from ${deviceId}:`, data);
        
        // Extract fields using Windows app format names
        const hostId = data.hostId || data.deviceId || deviceId;
        const systemName = data.systemName || 'Unknown Device';
        const apiKey = data.apiKey;
        const metadata = data.metadata || {};
        
        // Validate required fields
        if (!hostId || !apiKey) {
          socket.emit('error', { 
            error: 'Missing required fields' 
          });
          return;
        }

        // Validate API key
        const isValidKey = await deviceManager.validateApiKey(apiKey);
        if (!isValidKey) {
          socket.emit('error', { 
            error: 'Invalid API key' 
          });
          return;
        }

        // Register device in database
        const device = await deviceManager.registerDevice({
          deviceId: hostId,
          systemName,
          status: 'online',
          lastConnection: new Date(),
          apiKey,
          metadata: metadata || {}
        });

        // Send confirmation exactly as Windows app expects
        socket.emit('registration-success', { 
          deviceId: hostId,
          status: "registered",
          timestamp: new Date().toISOString()
        });

        // Update all dashboard clients
        this.io.emit('device-status-update', {
          deviceId: hostId,
          systemName,
          status: 'online',
          timestamp: new Date().toISOString()
        });

        logger.info(`Device registered: ${hostId} (${systemName})`);
      } catch (error) {
        logger.error(`Device registration error:`, error);
        socket.emit('error', { 
          error: error.message 
        });
      }
    });

    // Handle both heartbeat formats: Windows uses Engine.IO ping (2) packet
    // Handle raw Engine.IO ping packet (type 2)
    socket.conn.on('packet', (packet) => {
      if (packet.type === 2) { // Engine.IO ping packet
        // Update timestamp
        this.connectionTimestamps.set(deviceId, Date.now());
        // Update device last seen
        deviceManager.updateDeviceLastSeen(deviceId)
          .catch(err => logger.error(`Error updating device last seen: ${err.message}`));
          
        // Send pong (type 3) if needed - Engine.IO should do this automatically
        // but we're ensuring it happens for Windows app compatibility
        try {
          socket.conn.sendPacket('pong');
        } catch (e) {
          // Ignore errors sending pong
        }
      }
    });
    
    // Handle explicit heartbeat event
    socket.on('heartbeat', (data) => {
      this.connectionTimestamps.set(deviceId, Date.now());
      deviceManager.updateDeviceLastSeen(deviceId)
        .catch(err => logger.error(`Error updating device last seen: ${err.message}`));
    });

    // Socket.IO ping is handled internally, but we can log it
    socket.on('ping', () => {
      this.connectionTimestamps.set(deviceId, Date.now());
      deviceManager.updateDeviceLastSeen(deviceId)
        .catch(err => logger.error(`Error updating device last seen: ${err.message}`));
    });

    // WebRTC signaling handlers - modified to match Windows app format exactly
    socket.on('message', async (data) => {
      try {
        // Extract message type and routing information
        const messageType = data.type?.toLowerCase();
        const targetId = data.to;
        const senderId = data.from || deviceId;
        
        // Skip processing if no target
        if (!targetId || !messageType) {
          return;
        }
        
        // Find target socket
        const targetSocket = this.activeConnections.get(targetId);
        if (!targetSocket) {
          logger.warn(`Target not found for message ${messageType} from ${senderId} to ${targetId}`);
          return;
        }
        
        // Forward message exactly as received (maintaining format integrity)
        // but ensure 'from' field is set correctly
        const forwardedMessage = {
          ...data,
          from: senderId
        };
        
        targetSocket.emit('message', forwardedMessage);
        
        // Log message type for debugging
        logger.debug(`Forwarded ${messageType} message from ${senderId} to ${targetId}`);
        
        // For offers, update connection status
        if (messageType === 'offer' && data.payload) {
          // Update device last seen
          await deviceManager.updateDeviceLastSeen(deviceId);
        }
      } catch (error) {
        logger.error(`Error processing message from ${deviceId}:`, error);
      }
    });
    
    // Specific handlers for backward compatibility
    
    socket.on('offer', (data) => {
      try {
        // Extract data from different possible formats
        let targetId, offer;
        
        // Format 1: { targetId, offer: { sdp, type } }
        if (data.targetId && data.offer) {
          targetId = data.targetId;
          offer = data.offer;
        }
        // Format 2: { to, payload: { sdp, type } }
        else if (data.to && data.payload) {
          targetId = data.to;
          offer = {
            sdp: data.payload.sdp,
            type: data.payload.type
          };
        }
        
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'offer',
            from: deviceId,
            to: targetId,
            payload: {
              sdp: offer.sdp,
              type: offer.type
            }
          });
        }
      } catch (error) {
        logger.error(`Error processing offer from ${deviceId}:`, error);
      }
    });

    socket.on('answer', (data) => {
      try {
        // Extract data from different possible formats
        let targetId, answer;
        
        // Format 1: { targetId, answer: { sdp, type } }
        if (data.targetId && data.answer) {
          targetId = data.targetId;
          answer = data.answer;
        }
        // Format 2: { to, payload: { sdp, type } }
        else if (data.to && data.payload) {
          targetId = data.to;
          answer = {
            sdp: data.payload.sdp,
            type: data.payload.type
          };
        }
        
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'answer',
            from: deviceId,
            to: targetId,
            payload: {
              sdp: answer.sdp,
              type: answer.type,
              hostId: deviceId,
              accepted: true,
              timestamp: Date.now()
            }
          });
        }
      } catch (error) {
        logger.error(`Error processing answer from ${deviceId}:`, error);
      }
    });

    socket.on('ice-candidate', (data) => {
      try {
        // Extract data from different possible formats
        let targetId, candidate;
        
        // Format 1: { targetId, candidate: { candidate, sdpMLineIndex, sdpMid } }
        if (data.targetId && data.candidate) {
          targetId = data.targetId;
          candidate = data.candidate;
        }
        // Format 2: { to, payload: { candidate, sdpMLineIndex, sdpMid } }
        else if (data.to && data.payload) {
          targetId = data.to;
          candidate = {
            candidate: data.payload.candidate,
            sdpMLineIndex: data.payload.sdpMLineIndex,
            sdpMid: data.payload.sdpMid
          };
        }
        
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'ice-candidate',
            from: deviceId,
            to: targetId,
            payload: {
              candidate: candidate.candidate,
              sdpMLineIndex: candidate.sdpMLineIndex,
              sdpMid: candidate.sdpMid
            }
          });
        }
      } catch (error) {
        logger.error(`Error processing ICE candidate from ${deviceId}:`, error);
      }
    });

    // Handle control response with format that matches Windows app
    socket.on('control-response', (data) => {
      try {
        const { requestId, accepted, peerId } = data;
        const targetSocket = this.activeConnections.get(peerId);
        
        if (targetSocket) {
          // Format matches Windows app expectation
          targetSocket.emit('control-response', {
            requestId,
            deviceId,
            accepted
          });
        }
      } catch (error) {
        logger.error(`Error processing control response from ${deviceId}:`, error);
      }
    });
    
    // Handle Windows app specific control commands
    socket.on('control-command', (data) => {
      try {
        if (data.peerId && this.activeConnections.has(data.peerId)) {
          const targetSocket = this.activeConnections.get(data.peerId);
          // Pass along as is - Windows app format
          targetSocket.emit('control-command', data);
        }
      } catch (error) {
        logger.error(`Error processing control command from ${deviceId}:`, error);
      }
    });
  }

  /**
   * Handle web dashboard client connection
   * @param {Object} socket - Socket instance
   * @param {String} userId - User identifier
   */
  handleDashboardConnection(socket, userId) {
    // Store connection
    this.activeConnections.set(userId, socket);
    
    // Send initial device list
    deviceManager.getOnlineDevices()
      .then(devices => {
        socket.emit('device-list', devices);
      })
      .catch(error => {
        logger.error('Error retrieving device list:', error);
      });

    // Handle connection request
    socket.on('request-connection', async (data) => {
      try {
        const { deviceId, requestId } = data;
        const deviceSocket = this.activeConnections.get(deviceId);
        
        if (!deviceSocket) {
          socket.emit('connection-error', {
            requestId,
            error: 'Device not connected'
          });
          return;
        }

        // Log connection request
        await deviceManager.logConnectionRequest({
          deviceId,
          userId,
          requestId,
          timestamp: new Date()
        });

        // Format message as Windows app expects - exactly matching the format in 
        // the Windows app's SignalingService.cs
        deviceSocket.emit('message', {
          type: 'remote-control-request',
          from: userId,
          to: deviceId,
          payload: {
            requestId,
            peerId: userId
          }
        });
      } catch (error) {
        logger.error('Connection request error:', error);
        socket.emit('connection-error', {
          error: error.message
        });
      }
    });

    // Handle WebRTC signaling for dashboard, formatted for Windows app
    socket.on('message', (data) => {
      try {
        // Extract message type and routing information
        const messageType = data.type?.toLowerCase();
        const targetId = data.to;
        const senderId = data.from || userId;
        
        // Skip processing if no target
        if (!targetId || !messageType) {
          return;
        }
        
        // Find target socket
        const targetSocket = this.activeConnections.get(targetId);
        if (!targetSocket) {
          logger.warn(`Target not found for message ${messageType} from ${senderId} to ${targetId}`);
          socket.emit('connection-error', {
            error: `Target device ${targetId} not connected`
          });
          return;
        }
        
        // Forward message exactly as received (maintaining format integrity)
        // but ensure 'from' field is set correctly
        const forwardedMessage = {
          ...data,
          from: senderId
        };
        
        targetSocket.emit('message', forwardedMessage);
        
        // Log message type for debugging
        logger.debug(`Forwarded ${messageType} message from ${senderId} to ${targetId}`);
      } catch (error) {
        logger.error(`Error processing message from dashboard ${userId}:`, error);
        socket.emit('connection-error', {
          error: 'Error processing message: ' + error.message
        });
      }
    });
    
    // Specific handlers for backward compatibility
    
    socket.on('offer', (data) => {
      try {
        const { targetId, offer } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format exactly as Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'offer',
            from: userId,
            to: targetId,
            payload: {
              sdp: offer.sdp,
              type: offer.type
            }
          });
        } else {
          socket.emit('connection-error', {
            error: `Target device ${targetId} not connected`
          });
        }
      } catch (error) {
        logger.error(`Error sending offer from dashboard ${userId}:`, error);
        socket.emit('connection-error', {
          error: 'Error sending offer: ' + error.message
        });
      }
    });

    socket.on('answer', (data) => {
      try {
        const { targetId, answer } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format as Windows app expects
          targetSocket.emit('message', {
            type: 'answer',
            from: userId,
            to: targetId,
            payload: {
              sdp: answer.sdp,
              type: answer.type
            }
          });
        } else {
          socket.emit('connection-error', {
            error: `Target device ${targetId} not connected`
          });
        }
      } catch (error) {
        logger.error(`Error sending answer from dashboard ${userId}:`, error);
        socket.emit('connection-error', {
          error: 'Error sending answer: ' + error.message
        });
      }
    });

    socket.on('ice-candidate', (data) => {
      try {
        const { targetId, candidate } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format as Windows app expects in WebRTCService.cs
          targetSocket.emit('message', {
            type: 'ice-candidate',
            from: userId,
            to: targetId,
            payload: {
              candidate: candidate.candidate,
              sdpMLineIndex: candidate.sdpMLineIndex,
              sdpMid: candidate.sdpMid
            }
          });
        } else {
          socket.emit('connection-error', {
            error: `Target device ${targetId} not connected`
          });
        }
      } catch (error) {
        logger.error(`Error sending ICE candidate from dashboard ${userId}:`, error);
        socket.emit('connection-error', {
          error: 'Error sending ICE candidate: ' + error.message
        });
      }
    });

    // Handle remote control commands - format to match InputService.cs expectations
    socket.on('control-command', (data) => {
      try {
        const { deviceId, command } = data;
        const deviceSocket = this.activeConnections.get(deviceId);
        
        if (deviceSocket) {
          // Format to match what Windows app expects in InputService.cs
          deviceSocket.emit('control-command', {
            type: 'control-command',
            peerId: userId,
            command: typeof command === 'string' ? command : JSON.stringify(command)
          });
        } else {
          socket.emit('connection-error', {
            error: `Target device ${deviceId} not connected`
          });
        }
      } catch (error) {
        logger.error(`Error sending control command from dashboard ${userId}:`, error);
        socket.emit('connection-error', {
          error: 'Error sending control command: ' + error.message
        });
      }
    });
    
    // Handle device status requests
    socket.on('device-status-request', async (data) => {
      try {
        const { deviceId } = data;
        
        if (!deviceId) {
          return;
        }
        
        // Get current device status
        const device = await deviceManager.getDeviceById(deviceId);
        
        // Return the status
        socket.emit('device-status-update', {
          deviceId: device.deviceId,
          status: device.status,
          lastSeen: device.lastSeen,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error(`Error handling device status request from ${userId}:`, error);
      }
    });
  }

  /**
   * Monitor and maintain active connections
   */
  monitorConnections() {
    const now = Date.now();
    
    // Check all devices with timestamps
    this.connectionTimestamps.forEach(async (timestamp, deviceId) => {
      try {
        // Auto-detect device status based on last seen time
        await deviceManager.detectDeviceStatus(deviceId);
        
        // Get current device status
        const device = await deviceManager.getDeviceById(deviceId);
        
        // If device was online but is now idle/offline, notify clients
        if (device.status !== 'online' && this.activeConnections.has(deviceId)) {
          this.io.emit('device-status-update', {
            deviceId,
            status: device.status,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        // Handle error silently - device might have been deleted
        logger.debug(`Error monitoring device ${deviceId}: ${error.message}`);
      }
    });
    
    // Clean up old timestamps for devices that are no longer connected
    this.connectionTimestamps.forEach((timestamp, deviceId) => {
      if (!this.activeConnections.has(deviceId)) {
        this.connectionTimestamps.delete(deviceId);
      }
    });
  }

  /**
   * Get active connection count
   * @returns {number} Number of active connections
   */
  getActiveConnectionCount() {
    return this.activeConnections.size;
  }

  /**
   * Get active connections by type
   * @param {string} type - Connection type ('device' or 'dashboard')
   * @returns {Array} Array of connection IDs
   */
  getConnectionsByType(type) {
    const connections = [];
    
    this.activeConnections.forEach((socket, id) => {
      // Check both query and socket property since Windows app might store it differently
      const socketType = socket.handshake.query.type || 
                        (socket.handshake.query.hostId ? 'device' : 
                        (socket.handshake.query.clientId ? 'dashboard' : 'unknown'));
      
      if (socketType === type) {
        connections.push(id);
      }
    });
    
    return connections;
  }
}

// Create and export singleton instance
module.exports = (function() {
  if (!instance) {
    instance = new SignalingService();
  }
  return instance;
})();