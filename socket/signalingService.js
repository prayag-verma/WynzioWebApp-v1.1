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
    // Store io instance
    this.io = null;
    // Monitoring interval ID
    this.monitorIntervalId = null;
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
      allowEIO3: true
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
    
    // Start new monitoring interval
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
    
    // Handle device client (Windows app)
    if (clientType === 'device') {
      this.handleDeviceConnection(socket, clientId);
    } 
    // Handle web dashboard client
    else if (clientType === 'dashboard') {
      this.handleDashboardConnection(socket, clientId);
    }

    // Generic disconnect handler
    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${clientId}`);
      this.activeConnections.delete(clientId);
      
      // Update status for devices
      if (clientType === 'device') {
        deviceManager.updateDeviceStatus(clientId, 'offline')
          .then(() => {
            this.io.emit('device-status-update', {
              deviceId: clientId,
              status: 'offline',
              timestamp: new Date().toISOString()
            });
          })
          .catch(err => logger.error(`Error updating device status: ${err.message}`));
      }
    });

    // Error handler
    socket.on('error', (error) => {
      logger.error(`Socket error for ${clientId}:`, error);
    });
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
        if (Array.isArray(deviceInfo)) {
          data = deviceInfo[1] || deviceInfo[0];
        } else {
          data = deviceInfo;
        }
        
        logger.debug(`Auto-register request from ${deviceId}:`, data);
        
        // Extract fields using Windows app format names
        const hostId = data.hostId || data.deviceId;
        const systemName = data.systemName;
        const apiKey = data.apiKey;
        const metadata = data.metadata || {};
        
        // Validate required fields
        if (!systemName || !hostId || !apiKey) {
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
          // Format to match what Windows app expects
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
          // Format to match what Windows app expects
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

    // Handle message event format used by Windows app
    socket.on('message', (data) => {
      try {
        // Pass through messages to target
        if (data.to && this.activeConnections.has(data.to)) {
          const targetSocket = this.activeConnections.get(data.to);
          targetSocket.emit('message', {
            ...data,
            from: deviceId
          });
        }
      } catch (error) {
        logger.error(`Error processing message from ${deviceId}:`, error);
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

        // Format message as Windows app expects
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
        }
      } catch (error) {
        logger.error(`Error sending offer from dashboard ${userId}:`, error);
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
        }
      } catch (error) {
        logger.error(`Error sending answer from dashboard ${userId}:`, error);
      }
    });

    socket.on('ice-candidate', (data) => {
      try {
        const { targetId, candidate } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format as Windows app expects
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
        }
      } catch (error) {
        logger.error(`Error sending ICE candidate from dashboard ${userId}:`, error);
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
        }
      } catch (error) {
        logger.error(`Error sending control command from dashboard ${userId}:`, error);
      }
    });
  }

  /**
   * Monitor and maintain active connections
   */
  monitorConnections() {
    const now = Date.now();
    
    // Check for timed out devices
    this.connectionTimestamps.forEach((timestamp, deviceId) => {
      if (now - timestamp > CLIENT_TIMEOUT) {
        const socket = this.activeConnections.get(deviceId);
        
        if (socket) {
          logger.warn(`Device timed out: ${deviceId}`);
          
          // Update device status
          deviceManager.updateDeviceStatus(deviceId, 'idle')
            .then(() => {
              // Notify all dashboard clients
              this.io.emit('device-status-update', {
                deviceId,
                status: 'idle',
                timestamp: new Date().toISOString()
              });
            })
            .catch(error => {
              logger.error(`Error updating device status: ${error.message}`);
            });
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