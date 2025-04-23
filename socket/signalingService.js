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
      pingInterval: 5000
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
    const clientType = socket.handshake.query.type;
    const clientId = socket.handshake.query.clientId || socket.id;

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
        deviceManager.updateDeviceStatus(clientId, 'offline');
        this.io.emit('device-status-update', {
          deviceId: clientId,
          status: 'offline',
          timestamp: new Date().toISOString()
        });
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

    // Auto-register handler - matches Windows app SignalingService.cs format
    socket.on('auto-register', async (deviceInfo) => {
      try {
        // Handle both direct object and array format (Socket.IO can send either)
        const data = Array.isArray(deviceInfo) ? deviceInfo[1] : deviceInfo;
        
        // Extract fields matching Windows app format
        const { hostId, systemName, apiKey, platform, version, timestamp, metadata } = data;
        
        logger.debug(`Auto-register request from ${deviceId}:`, data);
        
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

    // Heartbeat handler - supports Socket.IO standard pings
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

    // WebRTC signaling handlers
    socket.on('offer', (data) => {
      try {
        const { targetId, offer } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects
          targetSocket.emit('offer', {
            deviceId,
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
        const { targetId, answer } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects
          targetSocket.emit('answer', {
            deviceId,
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
        const { targetId, candidate } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format to match what Windows app expects
          targetSocket.emit('ice-candidate', {
            deviceId,
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

    // Handle remote control events
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

    // Handle message event (general purpose messaging)
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

        // Forward request to device - format matches Windows app expectation
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

    // Handle WebRTC signaling for dashboard
    socket.on('offer', (data) => {
      try {
        const { targetId, offer } = data;
        const targetSocket = this.activeConnections.get(targetId);
        
        if (targetSocket) {
          // Format for Windows app expectation
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
          // Format for Windows app expectation
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
          // Format for Windows app expectation
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

    // Handle remote control commands
    socket.on('control-command', (data) => {
      try {
        const { deviceId, command } = data;
        const deviceSocket = this.activeConnections.get(deviceId);
        
        if (deviceSocket) {
          // Format specific to Windows app InputService.cs expectation
          deviceSocket.emit('control-command', {
            type: 'control-command',
            peerId: userId,
            command: JSON.stringify(command)
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
      if (socket.handshake.query.type === type) {
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