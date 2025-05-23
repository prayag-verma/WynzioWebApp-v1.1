/**
 * WebSocket Signaling Service for Wynzio
 * Handles real-time communication between Windows clients and web dashboard
 * Updated to match Windows app's SignalingService.cs format exactly
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
const PING_TIMEOUT = 20000; // 20 seconds - matching Windows app default
const RECONNECT_BASE_DELAY = 30000; // 30 seconds to match Windows app RECONNECT_INTERVAL
const MAX_RECONNECT_ATTEMPTS = 5; // Match Windows app setting
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours to match Windows app SessionManager.cs exactly

// Ensure data directory exists
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
    // Store session expirations (SID validity) - Added for Windows app compatibility
    this.sessionExpirations = new Map();
    // Store device to session mappings for better reconnection handling
    this.deviceSessions = new Map();
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
      pingTimeout: PING_TIMEOUT, // Match Windows app settings
      pingInterval: HEARTBEAT_INTERVAL, // Match Windows app settings
      // Allow transport polling and websocket to match Windows app
      transports: ['polling', 'websocket'],
      // Make Socket.IO format compatible with Windows app
      allowEIO3: true,
      // Path must match Windows app SignalingService.cs -> '/signal/'
      path: '/signal/'
    });

    // Authentication middleware
    this.io.use(require('./middleware/socketAuth'));

    // Connection handler
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    // Start health monitoring
    this.startMonitoring();

    logger.info('WebSocket signaling service initialized with /signal/ path');
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
    // Check for both clientId and remotePcId to support Windows app format
    const clientId = socket.handshake.query.clientId || socket.id;
    const remotePcId = socket.handshake.query.remotePcId;
    
    // Check for client type - Windows app may not send this explicitly
    const clientType = socket.handshake.query.type || 
                      (remotePcId ? 'device' : 
                      (clientId && clientId.startsWith('web-client') ? 'dashboard' : 'unknown'));

    logger.info(`New ${clientType} connection: ${remotePcId || clientId}`);
    
    // Reset reconnection attempts on successful connection
    if (remotePcId) {
      this.reconnectAttempts.set(remotePcId, 0);
    } else {
      this.reconnectAttempts.set(clientId, 0);
    }
    
    // Clear any pending reconnect timer
    if (remotePcId && this.reconnectTimers.has(remotePcId)) {
      clearTimeout(this.reconnectTimers.get(remotePcId));
      this.reconnectTimers.delete(remotePcId);
    } else if (this.reconnectTimers.has(clientId)) {
      clearTimeout(this.reconnectTimers.get(clientId));
      this.reconnectTimers.delete(clientId);
    }
    
    // Set session expiration (24 hours from now) - added for Windows app compatibility
    this.sessionExpirations.set(socket.id, Date.now() + SESSION_TIMEOUT);
    
    // Store device session mapping if device type
    if (remotePcId) {
      this.storeConnection(remotePcId, socket.id);
    }
    
    // Handle device client (Windows app)
    if (clientType === 'device') {
      this.handleDeviceConnection(socket, remotePcId);
    } 
    // Handle web dashboard client
    else if (clientType === 'dashboard') {
      this.handleDashboardConnection(socket, clientId);
    }

    // Generic disconnect handler
    socket.on('disconnect', (reason) => {
      if (remotePcId) {
        logger.info(`Device disconnected: ${remotePcId}, reason: ${reason}`);
        
        // Don't immediately remove from active connections - keep it for reconnection grace period
        // Instead, mark last disconnect time for cleanup during monitoring
        this.connectionTimestamps.set(remotePcId, Date.now() - RECONNECT_BASE_DELAY); // Mark as potentially reconnecting
        
        // Update status for devices
        deviceManager.updateDeviceStatus(remotePcId, 'offline')
          .then(() => {
            this.io.emit('device-status-update', {
              remotePcId: remotePcId,
              status: 'offline',
              timestamp: new Date().toISOString(),
              reason: reason
            });
          })
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
          
        // Schedule reconnection attempt if not an intentional disconnect
        if (reason !== 'client namespace disconnect' && reason !== 'io server disconnect') {
          this.scheduleReconnection(remotePcId, clientType);
        }
      } else {
        logger.info(`Client disconnected: ${clientId}, reason: ${reason}`);
        this.activeConnections.delete(clientId);
      }
    });

    // Error handler
    socket.on('error', (error) => {
      if (remotePcId) {
        logger.error(`Socket error for device ${remotePcId}:`, error);
      } else {
        logger.error(`Socket error for client ${clientId}:`, error);
      }
    });
    
    // Handle reconnect events
    socket.on('reconnect', (attemptNumber) => {
      if (remotePcId) {
        logger.info(`Device ${remotePcId} reconnected after ${attemptNumber} attempts`);
        
        // Reset reconnection attempts
        this.reconnectAttempts.set(remotePcId, 0);
        
        // Ensure device is in activeConnections
        this.activeConnections.set(remotePcId, socket);
        
        // Update device status if reconnected
        deviceManager.updateDeviceStatus(remotePcId, 'online')
          .then(() => {
            this.io.emit('device-status-update', {
              remotePcId: remotePcId,
              status: 'online',
              timestamp: new Date().toISOString()
            });
          })
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
      } else {
        logger.info(`Client ${clientId} reconnected after ${attemptNumber} attempts`);
        this.reconnectAttempts.set(clientId, 0);
      }
    });
    
    // Handle explicit reconnection failure
    socket.on('reconnect_failed', () => {
      if (remotePcId) {
        logger.warn(`Device ${remotePcId} failed to reconnect after max attempts`);
        
        // Mark device as offline if it's a device
        deviceManager.updateDeviceStatus(remotePcId, 'offline')
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
      } else {
        logger.warn(`Client ${clientId} failed to reconnect after max attempts`);
      }
    });
  }

  /**
   * Monitor device connection
   * @param {String} remotePcId - Device ID
   */
  monitorDeviceConnection(remotePcId) {
    if (!remotePcId || !this.activeConnections.has(remotePcId)) return;
    
    const socket = this.activeConnections.get(remotePcId);
    
    // Log connection details initially
    logger.info(`Monitoring device connection: ${remotePcId}, transport: ${socket.conn.transport.name}`);
    
    // Add packet monitoring to track exactly what's happening with the WebSocket
    socket.conn.on('packet', (packet) => {
      // Only log important packets to avoid excessive logging
      if (packet.type === 0) { // Engine.IO open packet
        logger.info(`Device ${remotePcId} - Received Engine.IO open packet`);
      } else if (packet.type === 4) { // Engine.IO message packet
        if (packet.data.startsWith('0')) { // Socket.IO connect packet
          logger.info(`Device ${remotePcId} - Socket.IO namespace connected`);
        } else if (packet.data.startsWith('4')) { // Socket.IO disconnect packet
          logger.info(`Device ${remotePcId} - Socket.IO namespace disconnected`);
        } else if (packet.data.startsWith('2')) { // Socket.IO event packet
          // Only log if it contains specific keywords indicating issues
          const packetData = packet.data.substring(2);
          try {
            const eventData = JSON.parse(packetData);
            const eventName = eventData[0];
            if (eventName === 'error' || eventName === 'connect_error' || eventName === 'reconnect_error') {
              logger.warn(`Device ${remotePcId} - Socket.IO error event: ${packetData}`);
            }
          } catch (e) {
            // Ignore parsing errors for non-JSON packets
          }
        }
      } else if (packet.type === 2) { // Engine.IO ping packet
        // Log every 5th ping for monitoring without excessive logs
        if (this._pingCounter === undefined) this._pingCounter = 0;
        this._pingCounter++;
        if (this._pingCounter % 5 === 0) {
          logger.debug(`Device ${remotePcId} - Engine.IO ping sent`);
        }
      } else if (packet.type === 3) { // Engine.IO pong packet
        if (this._pingCounter % 5 === 0) {
          logger.debug(`Device ${remotePcId} - Engine.IO pong received`);
        }
      } else if (packet.type === 1) { // Engine.IO close packet
        logger.warn(`Device ${remotePcId} - Engine.IO close packet received`);
      }
    });
    
    // Monitor for specific transport-level events
    socket.conn.transport.on('error', (err) => {
      logger.error(`Device ${remotePcId} - Transport error: ${err.message || 'Unknown'}`);
    });
    
    socket.conn.on('upgrade', (transport) => {
      logger.info(`Device ${remotePcId} - Transport upgraded from ${socket.conn.transport.name} to ${transport.name}`);
    });
    
    socket.conn.on('close', (reason) => {
      logger.warn(`Device ${remotePcId} - Connection closed: ${reason}`);
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   * @param {String} remotePcId - Remote PC identifier
   * @param {String} clientType - Client type ('device' or 'dashboard')
   */
  scheduleReconnection(remotePcId, clientType) {
    // Only schedule reconnection for devices
    if (clientType !== 'device') return;
    
    // Get current attempt count
    let attempts = this.reconnectAttempts.get(remotePcId) || 0;
    
    // Stop after max attempts - match Windows app exactly
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn(`Maximum reconnection attempts reached for ${remotePcId}`);
      return;
    }
    
    // Use fixed reconnect interval to match Windows app
    const delay = RECONNECT_BASE_DELAY;
    logger.info(`Scheduling reconnection for ${remotePcId} in ${delay}ms (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
    
    // Schedule reconnection
    const timer = setTimeout(() => {
      // Increment attempt counter
      this.reconnectAttempts.set(remotePcId, attempts + 1);
      
      // Try to reconnect by notifying all clients about an offline device
      // that might be trying to reconnect
      this.io.emit('reconnect-attempt', {
        remotePcId: remotePcId,
        attempt: attempts + 1,
        timestamp: new Date().toISOString()
      });
      
      // Schedule next attempt if not max attempts
      if (attempts + 1 < MAX_RECONNECT_ATTEMPTS) {
        this.scheduleReconnection(remotePcId, clientType);
      }
    }, delay);
    
    // Store the timer
    this.reconnectTimers.set(remotePcId, timer);
  }

  /**
   * Handle device client connection (Windows app)
   * @param {Object} socket - Socket instance
   * @param {String} remotePcId - Remote PC identifier
   */
  handleDeviceConnection(socket, remotePcId) {
    // Store connection
    this.activeConnections.set(remotePcId, socket);
    this.connectionTimestamps.set(remotePcId, Date.now());

    // Start connection monitoring
    this.monitorDeviceConnection(remotePcId);

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
        
        logger.debug(`Auto-register request from ${remotePcId}:`, data);
        
        // Extract fields using Windows app format names
        const receivedRemotePcId = data.remotePcId || remotePcId;
        const systemName = data.systemName || 'Unknown Device';
        const apiKey = data.apiKey;
        const metadata = {
          OSName: data.OSName,
          OSversion: data.OSversion
        };
        
        // Validate required fields
        if (!receivedRemotePcId || !apiKey) {
          socket.emit('error', { 
            error: 'Missing required fields' 
          });
          return;
        }

        // Validate API key - exact match with the key from Windows app
        const isValidKey = await deviceManager.validateApiKey(apiKey);
        if (!isValidKey) {
          socket.emit('error', { 
            error: 'Invalid API key' 
          });
          return;
        }

        // Register device in database
        const device = await deviceManager.registerDevice({
          remotePcId: receivedRemotePcId,
          systemName,
          status: 'online',
          lastConnection: new Date(),
          apiKey,
          metadata: metadata || {}
        });

        // Send confirmation exactly as Windows app expects
        socket.emit('registration-success', { 
          status: "success"
        });

        // Update all dashboard clients
        this.io.emit('device-status-update', {
          remotePcId: receivedRemotePcId,
          systemName,
          status: 'online',
          timestamp: new Date().toISOString()
        });

        logger.info(`Device registered: ${receivedRemotePcId} (${systemName})`);
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
        this.connectionTimestamps.set(remotePcId, Date.now());
        // Update device last seen
        deviceManager.updateDeviceLastSeen(remotePcId)
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
      this.connectionTimestamps.set(remotePcId, Date.now());
      deviceManager.updateDeviceLastSeen(remotePcId)
        .catch(err => logger.error(`Error updating device last seen: ${err.message}`));
    });

    // Socket.IO ping is handled internally, but we can log it
    socket.on('ping', () => {
      this.connectionTimestamps.set(remotePcId, Date.now());
      deviceManager.updateDeviceLastSeen(remotePcId)
        .catch(err => logger.error(`Error updating device last seen: ${err.message}`));
    });

    // WebRTC signaling handlers - modified to match Windows app format exactly
    socket.on('message', async (data) => {
      try {
        // Extract message type and routing information
        const messageType = data.type?.toLowerCase();
        const targetId = data.to;
        const senderId = data.from || remotePcId;
        
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
        
        // Format message to match exactly what Windows app expects
        const forwardedMessage = {
          type: messageType,
          from: senderId,
          to: targetId,
          payload: data.payload || {}
        };
        
        // Forward message to target
        targetSocket.emit('message', forwardedMessage);
        
        // Log message type for debugging
        logger.debug(`Forwarded ${messageType} message from ${senderId} to ${targetId}`);
        
        // For offers, update connection status
        if (messageType === 'offer' && data.payload) {
          // Update device last seen
          await deviceManager.updateDeviceLastSeen(remotePcId);
        }
      } catch (error) {
        logger.error(`Error processing message from ${remotePcId}:`, error);
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
        } else {
          logger.warn(`Invalid offer format from ${remotePcId}`);
          return;
        }
        
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'offer',
            from: remotePcId,
            to: targetId,
            payload: {
              sdp: offer.sdp,
              type: offer.type
            }
          });
        }
      } catch (error) {
        logger.error(`Error processing offer from ${remotePcId}:`, error);
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
        } else {
          logger.warn(`Invalid answer format from ${remotePcId}`);
          return;
        }
        
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'answer',
            from: remotePcId,
            to: targetId,
            payload: {
              sdp: answer.sdp,
              type: answer.type
            }
          });
        }
      } catch (error) {
        logger.error(`Error processing answer from ${remotePcId}:`, error);
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
        } else {
          logger.warn(`Invalid ICE candidate format from ${remotePcId}`);
          return;
        }
        
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects in SignalingService.cs
          targetSocket.emit('message', {
            type: 'ice-candidate',
            from: remotePcId,
            to: targetId,
            payload: {
              candidate: candidate.candidate,
              sdpMLineIndex: candidate.sdpMLineIndex,
              sdpMid: candidate.sdpMid
            }
          });
        }
      } catch (error) {
        logger.error(`Error processing ICE candidate from ${remotePcId}:`, error);
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
            remotePcId,
            accepted
          });
        }
      } catch (error) {
        logger.error(`Error processing control response from ${remotePcId}:`, error);
      }
    });
    
    // Handle Windows app specific control commands
    socket.on('control-command', (data) => {
      try {
        if (data.peerId && this.activeConnections.has(data.peerId)) {
          const targetSocket = this.activeConnections.get(data.peerId);
          // Pass along as is - Windows app format
          targetSocket.emit('control-command', {
            type: 'control-command',
            peerId: remotePcId,
            command: typeof data.command === 'string' ? data.command : JSON.stringify(data.command)
          });
        }
      } catch (error) {
        logger.error(`Error processing control command from ${remotePcId}:`, error);
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
    
    // Handle session reuse - for WebSocket connections from Windows app
    const sid = socket.handshake.auth.sid;
    if (sid) {
      const sessionExpiration = this.sessionExpirations.get(sid);
      if (sessionExpiration && Date.now() < sessionExpiration) {
        logger.info(`Reusing valid session: ${sid} for client ${userId}`);
        // Extend session expiration
        this.sessionExpirations.set(socket.id, Date.now() + SESSION_TIMEOUT);
      } else {
        logger.info(`Session expired or invalid: ${sid} for client ${userId}`);
        // Set new session expiration
        this.sessionExpirations.set(socket.id, Date.now() + SESSION_TIMEOUT);
      }
    } else {
      // New session
      this.sessionExpirations.set(socket.id, Date.now() + SESSION_TIMEOUT);
    }
    
    // Send initial device list
    deviceManager.getOnlineDevices()
      .then(devices => {
        socket.emit('device-list', devices);
      })
      .catch(error => {
        logger.error('Error retrieving device list:', error);
      });

    // Handle device list request
    socket.on('device-list-request', async () => {
      try {
        const devices = await deviceManager.getOnlineDevices();
        socket.emit('device-list', devices);
      } catch (error) {
        logger.error('Error retrieving device list:', error);
      }
    });

    // Handle connection request
    socket.on('request-connection', async (data) => {
      try {
        const { remotePcId, requestId } = data;
        
        if (!remotePcId) {
          socket.emit('connection-error', {
            requestId,
            error: 'Missing remotePcId'
          });
          return;
        }
        
        // Try to find the device in active connections
        let deviceSocket = this.activeConnections.get(remotePcId);
        
        // If device socket not found, try to see if it exists in database and is marked online
        if (!deviceSocket) {
          try {
            // Get device from database
            const device = await deviceManager.getDeviceByRemotePcId(remotePcId);
            
            // If device exists and is marked as online, try to restore connection
            if (device && device.status === 'online') {
              // Check if we have a session mapping for this device
              const sessionId = this.deviceSessions.get(remotePcId);
              
              if (sessionId && this.io.sockets && this.io.sockets.sockets) {
                deviceSocket = this.io.sockets.sockets.get(sessionId);
                
                if (deviceSocket) {
                  logger.info(`Restored connection for device ${remotePcId} from session mapping`);
                  // Update active connections map
                  this.activeConnections.set(remotePcId, deviceSocket);
                }
              }
            }
          } catch (err) {
            // Device not found in database, continue with error response
            logger.warn(`Device ${remotePcId} not found in database`);
          }
        }
        
        // If device socket still not found, send error
        if (!deviceSocket) {
          socket.emit('connection-error', {
            requestId,
            error: 'Device not connected'
          });
          return;
        }

        // Log connection request
        await deviceManager.logConnectionRequest({
          remotePcId,
          userId,
          requestId,
          timestamp: new Date()
        });

        // Format message as Windows app expects - exactly matching the format in 
        // the Windows app's SignalingService.cs
        deviceSocket.emit('message', {
          type: 'remote-control-request',
          from: userId,
          to: remotePcId,
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
          
          // FIX: Try to check if there is a stored session for this device
          const sessionId = this.deviceSessions.get(targetId);
          let restoredSocket = null;
          
          if (sessionId && this.io.sockets && this.io.sockets.sockets) {
            restoredSocket = this.io.sockets.sockets.get(sessionId);
            
            if (restoredSocket) {
              logger.info(`Restored connection for device ${targetId} during message routing`);
              // Update active connections map
              this.activeConnections.set(targetId, restoredSocket);
              targetSocket = restoredSocket;
            }
          }
          
          // If we still couldn't find the socket, return error
          if (!targetSocket) {
            socket.emit('connection-error', {
              error: `Target device ${targetId} not connected`
            });
            return;
          }
        }
        
        // Format message to match exactly what Windows app expects
        const forwardedMessage = {
          type: messageType,
          from: senderId,
          to: targetId,
          payload: data.payload || {}
        };
        
        // Forward message to target
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
          // Try to find the socket through session mapping
          const sessionId = this.deviceSessions.get(targetId);
          let restoredSocket = null;
          
          if (sessionId && this.io.sockets && this.io.sockets.sockets) {
            restoredSocket = this.io.sockets.sockets.get(sessionId);
            
            if (restoredSocket) {
              logger.info(`Restored connection for device ${targetId} during offer`);
              // Update active connections map
              this.activeConnections.set(targetId, restoredSocket);
              
              // Send offer with restored socket
              restoredSocket.emit('message', {
                type: 'offer',
                from: userId,
                to: targetId,
                payload: {
                  sdp: offer.sdp,
                  type: offer.type
                }
              });
              return;
            }
          }
          
          // If we still couldn't find the socket, return error
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
        const { remotePcId, command } = data;
        const deviceSocket = this.activeConnections.get(remotePcId);
        
        if (deviceSocket) {
          // Format to match what Windows app expects in InputService.cs
          deviceSocket.emit('control-command', {
            type: 'control-command',
            peerId: userId,
            command: typeof command === 'string' ? command : JSON.stringify(command)
          });
        } else {
          socket.emit('connection-error', {
            error: `Target device ${remotePcId} not connected`
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
        const { remotePcId } = data;
        
        if (!remotePcId) {
          return;
        }
        
        // Get current device status
        const device = await deviceManager.getDeviceByRemotePcId(remotePcId);
        
        // Return the status
        socket.emit('device-status-update', {
          remotePcId: device.remotePcId,
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
   * Handle connection request with socket
   * @param {Object} clientSocket - Client socket
   * @param {Object} deviceSocket - Device socket
   * @param {String} userId - User ID
   * @param {String} remotePcId - Remote PC ID
   * @param {String} requestId - Request ID
   */
  async handleConnectionRequestWithSocket(clientSocket, deviceSocket, userId, remotePcId, requestId) {
    try {
      // Log connection request
      await deviceManager.logConnectionRequest({
        remotePcId,
        userId,
        requestId,
        timestamp: new Date()
      });

      // Format message as Windows app expects
      deviceSocket.emit('message', {
        type: 'remote-control-request',
        from: userId,
        to: remotePcId,
        payload: {
          requestId,
          peerId: userId
        }
      });
    } catch (error) {
      logger.error('Connection request with socket error:', error);
      clientSocket.emit('connection-error', {
        error: error.message
      });
    }
  }

  /**
   * Monitor and maintain active connections
   */
  monitorConnections() {
    const now = Date.now();
    
    // Check all devices with timestamps
    this.connectionTimestamps.forEach(async (timestamp, remotePcId) => {
      try {
        // Auto-detect device status based on last seen time
        await deviceManager.detectDeviceStatus(remotePcId);
        
        // Get current device status
        const device = await deviceManager.getDeviceByRemotePcId(remotePcId);
        
        // If device was online but is now idle/offline, notify clients
        if (device.status !== 'online' && this.activeConnections.has(remotePcId)) {
          this.io.emit('device-status-update', {
            remotePcId,
            status: device.status,
            timestamp: new Date().toISOString()
          });
        }
        
        // If device was offline but is now online (based on detectDeviceStatus), 
        // update active connections if needed
        if (device.status === 'online' && !this.activeConnections.has(remotePcId)) {
          // Check if we have a session mapping for this device
          const sid = this.deviceSessions.get(remotePcId);
          if (sid && this.io && this.io.sockets && this.io.sockets.sockets) {
            const socket = this.io.sockets.sockets.get(sid);
            if (socket) {
              // Update active connections map
              this.activeConnections.set(remotePcId, socket);
              logger.info(`Restored connection for device ${remotePcId} using session ${sid}`);
            }
          }
        }
      } catch (error) {
        // Handle error silently - device might have been deleted
        logger.debug(`Error monitoring device ${remotePcId}: ${error.message}`);
      }
    });
    
    // Clean up old timestamps for devices that are no longer connected
    this.connectionTimestamps.forEach((timestamp, remotePcId) => {
      // Don't remove if still in active connections
      if (!this.activeConnections.has(remotePcId)) {
        // Check if we should consider it really gone
        const timeSinceUpdate = now - timestamp;
        if (timeSinceUpdate > SESSION_TIMEOUT) {
          this.connectionTimestamps.delete(remotePcId);
          // Also clean up session mapping
          this.deviceSessions.delete(remotePcId);
          logger.debug(`Removed stale device: ${remotePcId}`);
        }
      }
    });
    
    // Clean up expired sessions
    this.sessionExpirations.forEach((expiration, sid) => {
      if (now > expiration) {
        this.sessionExpirations.delete(sid);
        logger.debug(`Session expired: ${sid}`);
        
        // Also check if any device was using this session
        for (const [deviceId, deviceSid] of this.deviceSessions.entries()) {
          if (deviceSid === sid) {
            this.deviceSessions.delete(deviceId);
            logger.debug(`Removed device session mapping for ${deviceId}`);
          }
        }
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
                        (socket.handshake.query.remotePcId ? 'device' : 
                        (socket.handshake.query.clientId ? 'dashboard' : 'unknown'));
      
      if (socketType === type) {
        connections.push(id);
      }
    });
    
    return connections;
  }
  
  /**
   * Check if a session ID is valid and not expired
   * @param {string} sid - Session ID to check
   * @returns {boolean} Whether the session is valid
   */
  isSessionValid(sid) {
    try {
      // Check if direct match in session expirations map
      const expiration = this.sessionExpirations.get(sid);
      if (expiration !== undefined && Date.now() < expiration) {
        return true;
      }
      
      // Check active connections for this session ID
      if (this.io && this.io.sockets && this.io.sockets.sockets) {
        const socket = this.io.sockets.sockets.get(sid);
        if (socket) {
          return true;
        }
      }
      
      // Check if we have this session in the device mappings
      if (Array.from(this.deviceSessions.values()).includes(sid)) {
        return true;
      }
      
      // Try to parse sid as a session object (matching Windows app format)
      let sessionObj;
      
      try {
        sessionObj = JSON.parse(sid);
      } catch (e) {
        // Not a JSON string, use as is
        sessionObj = null;
      }
      
      // If we have a timestamp (from SessionManager.cs format)
      if (sessionObj && sessionObj.Timestamp) {
        const timestamp = parseInt(sessionObj.Timestamp, 10);
        return !isNaN(timestamp) && (Date.now() - timestamp < SESSION_TIMEOUT);
      } else if (sessionObj && sessionObj.Sid) {
        // Use Sid property directly
        return this.isSessionValid(sessionObj.Sid);
      }
    } catch (e) {
      logger.debug(`Error checking session validity: ${e.message}`);
    }
    
    return false;
  }
  
  /**
   * Extend session expiration
   * @param {string} sid - Session ID to extend
   */
  extendSession(sid) {
    if (this.sessionExpirations.has(sid)) {
      this.sessionExpirations.set(sid, Date.now() + SESSION_TIMEOUT);
      logger.debug(`Session extended: ${sid}`);
    }
  }
  
  /**
   * Store connection mapping for better reconnection handling
   * @param {string} remotePcId - Device ID 
   * @param {string} sid - Session ID
   */
  storeConnection(remotePcId, sid) {
    if (!remotePcId || !sid) return;
    
    // Update session expiration time
    this.sessionExpirations.set(sid, Date.now() + SESSION_TIMEOUT);
    
    // Create mapping from device to session
    this.deviceSessions.set(remotePcId, sid);
    
    // Also update the active connections map if it's not already there
    if (!this.activeConnections.has(remotePcId) && this.io) {
      // Find the socket by session ID
      if (this.io.sockets && this.io.sockets.sockets) {
        const socket = this.io.sockets.sockets.get(sid);
        if (socket) {
          this.activeConnections.set(remotePcId, socket);
          logger.info(`Updated active connection for device ${remotePcId} using session ${sid}`);
        }
      }
    }
    
    logger.debug(`Stored connection mapping: ${remotePcId} -> ${sid}`);
  }
}

// Create and export singleton instance
module.exports = (function() {
  if (!instance) {
    instance = new SignalingService();
  }
  return instance;
})();