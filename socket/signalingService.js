/**
 * WebSocket Signaling Service for Wynzio
 * Handles real-time communication between Windows clients and web dashboard
 */
const socketIo = require('socket.io');
const deviceManager = require('../api/services/deviceManager');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

// Constants
const DEVICE_DATA_DIR = path.join(__dirname, '../data/devices');
const CLIENT_TIMEOUT = 30000; // 30 seconds

// Create data directory if it doesn't exist
if (!fs.existsSync(DEVICE_DATA_DIR)) {
  fs.mkdirSync(DEVICE_DATA_DIR, { recursive: true });
}

// Store active connections
const activeConnections = new Map();
// Store connection timestamps for health monitoring
const connectionTimestamps = new Map();

/**
 * Initialize WebSocket server
 * @param {Object} server - HTTP server instance
 * @return {Object} Socket.IO instance
 */
function initialize(server) {
  const io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingTimeout: 10000,
    pingInterval: 5000
  });

  // Authentication middleware
  io.use(require('./middleware/socketAuth'));

  // Connection handler
  io.on('connection', (socket) => {
    handleConnection(socket, io);
  });

  // Start health monitoring
  setInterval(() => monitorConnections(io), 15000);

  logger.info('WebSocket signaling service initialized');
  return io;
}

/**
 * Handle new socket connection
 * @param {Object} socket - Socket instance
 * @param {Object} io - Socket.IO server instance
 */
function handleConnection(socket, io) {
  const clientType = socket.handshake.query.type;
  const clientId = socket.handshake.query.clientId || socket.id;

  logger.info(`New ${clientType} connection: ${clientId}`);
  
  // Handle device client (Windows app)
  if (clientType === 'device') {
    handleDeviceConnection(socket, io, clientId);
  } 
  // Handle web dashboard client
  else if (clientType === 'dashboard') {
    handleDashboardConnection(socket, io, clientId);
  }

  // Generic disconnect handler
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${clientId}`);
    activeConnections.delete(clientId);
    
    // Update status for devices
    if (clientType === 'device') {
      deviceManager.updateDeviceStatus(clientId, 'offline');
      io.emit('device-status-update', {
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
 * @param {Object} io - Socket.IO server instance 
 * @param {String} deviceId - Device identifier
 */
function handleDeviceConnection(socket, io, deviceId) {
  // Store connection
  activeConnections.set(deviceId, socket);
  connectionTimestamps.set(deviceId, Date.now());

  // Auto-register handler
  socket.on('auto-register', async (deviceInfo) => {
    try {
      const { systemName, hostId, apiKey } = deviceInfo;
      
      // Validate required fields
      if (!systemName || !hostId || !apiKey) {
        socket.emit('registration-error', { 
          error: 'Missing required fields' 
        });
        return;
      }

      // Register device in database
      const device = await deviceManager.registerDevice({
        deviceId: hostId,
        systemName,
        status: 'online',
        lastConnection: new Date(),
        apiKey
      });

      // Send confirmation
      socket.emit('registration-success', { 
        deviceId: hostId,
        timestamp: new Date().toISOString()
      });

      // Update all dashboard clients
      io.emit('device-status-update', {
        deviceId: hostId,
        systemName,
        status: 'online',
        timestamp: new Date().toISOString()
      });

      logger.info(`Device registered: ${hostId} (${systemName})`);
    } catch (error) {
      logger.error(`Device registration error:`, error);
      socket.emit('registration-error', { 
        error: error.message 
      });
    }
  });

  // Heartbeat handler
  socket.on('heartbeat', (data) => {
    connectionTimestamps.set(deviceId, Date.now());
    deviceManager.updateDeviceLastSeen(deviceId);
  });

  // WebRTC signaling handlers
  socket.on('offer', (data) => {
    const { targetId, offer } = data;
    const targetSocket = activeConnections.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('offer', {
        deviceId,
        offer
      });
    }
  });

  socket.on('answer', (data) => {
    const { targetId, answer } = data;
    const targetSocket = activeConnections.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('answer', {
        deviceId,
        answer
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { targetId, candidate } = data;
    const targetSocket = activeConnections.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('ice-candidate', {
        deviceId,
        candidate
      });
    }
  });

  // Handle remote control events
  socket.on('control-response', (data) => {
    const { requestId, accepted, peerId } = data;
    const targetSocket = activeConnections.get(peerId);
    
    if (targetSocket) {
      targetSocket.emit('control-response', {
        requestId,
        deviceId,
        accepted
      });
    }
  });
}

/**
 * Handle web dashboard client connection
 * @param {Object} socket - Socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {String} userId - User identifier
 */
function handleDashboardConnection(socket, io, userId) {
  // Store connection
  activeConnections.set(userId, socket);
  
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
      const deviceSocket = activeConnections.get(deviceId);
      
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

      // Forward request to device
      deviceSocket.emit('remote-control-request', {
        requestId,
        peerId: userId
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
    const { targetId, offer } = data;
    const targetSocket = activeConnections.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('offer', {
        deviceId: userId,
        offer
      });
    }
  });

  socket.on('answer', (data) => {
    const { targetId, answer } = data;
    const targetSocket = activeConnections.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('answer', {
        deviceId: userId,
        answer
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { targetId, candidate } = data;
    const targetSocket = activeConnections.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('ice-candidate', {
        deviceId: userId,
        candidate
      });
    }
  });

  // Handle remote control commands
  socket.on('control-command', (data) => {
    const { deviceId, command } = data;
    const deviceSocket = activeConnections.get(deviceId);
    
    if (deviceSocket) {
      deviceSocket.emit('control-command', {
        peerId: userId,
        command
      });
    }
  });
}

/**
 * Monitor and maintain active connections
 * @param {Object} io - Socket.IO server instance
 */
function monitorConnections(io) {
  const now = Date.now();
  
  // Check for timeout devices
  connectionTimestamps.forEach((timestamp, deviceId) => {
    if (now - timestamp > CLIENT_TIMEOUT) {
      const socket = activeConnections.get(deviceId);
      
      if (socket) {
        logger.warn(`Device timed out: ${deviceId}`);
        
        // Update device status
        deviceManager.updateDeviceStatus(deviceId, 'idle')
          .then(() => {
            // Notify all dashboard clients
            io.emit('device-status-update', {
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

module.exports = {
  initialize
};