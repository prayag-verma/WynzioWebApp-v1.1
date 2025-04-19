/**
 * Device Controller
 * Handles API endpoints for device management
 */
const deviceManager = require('../services/deviceManager');
const healthMonitor = require('../services/healthMonitor');
const logger = require('../../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Register device (auto or manual)
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.registerDevice = async (req, res) => {
  try {
    const { deviceId, systemName, apiKey, metadata } = req.body;
    
    // Validate required fields
    if (!deviceId || !systemName || !apiKey) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: deviceId, systemName, apiKey"
      });
    }
    
    // Validate API key
    const isValidKey = await deviceManager.validateApiKey(apiKey);
    if (!isValidKey) {
      return res.status(401).json({
        success: false,
        message: "Invalid API key"
      });
    }
    
    // Register device
    const device = await deviceManager.registerDevice({
      deviceId,
      systemName,
      status: 'online',
      apiKey,
      metadata: metadata || {}
    });
    
    // Return success
    res.json({
      success: true,
      device: {
        deviceId: device.deviceId,
        systemName: device.systemName,
        status: device.status,
        firstConnection: device.firstConnection,
        lastConnection: device.lastConnection
      }
    });
  } catch (error) {
    logger.error('Device registration error:', error);
    res.status(500).json({
      success: false,
      message: "Server error during device registration"
    });
  }
};

/**
 * Get all devices
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getAllDevices = async (req, res) => {
  try {
    // Get devices
    const devices = await deviceManager.getAllDevices();
    
    // Filter sensitive data
    const filteredDevices = devices.map(device => ({
      deviceId: device.deviceId,
      systemName: device.systemName,
      status: device.status,
      firstConnection: device.firstConnection,
      lastConnection: device.lastConnection,
      lastSeen: device.lastSeen
    }));
    
    // Return success
    res.json({
      success: true,
      devices: filteredDevices
    });
  } catch (error) {
    logger.error('Error getting devices:', error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving devices"
    });
  }
};

/**
 * Get online devices
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getOnlineDevices = async (req, res) => {
  try {
    // Get online devices
    const devices = await deviceManager.getOnlineDevices();
    
    // Filter sensitive data
    const filteredDevices = devices.map(device => ({
      deviceId: device.deviceId,
      systemName: device.systemName,
      status: device.status,
      lastConnection: device.lastConnection,
      lastSeen: device.lastSeen
    }));
    
    // Return success
    res.json({
      success: true,
      devices: filteredDevices
    });
  } catch (error) {
    logger.error('Error getting online devices:', error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving online devices"
    });
  }
};

/**
 * Get device by ID
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getDeviceById = async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    // Get device
    const device = await deviceManager.getDeviceById(deviceId);
    
    // Filter sensitive data
    const filteredDevice = {
      deviceId: device.deviceId,
      systemName: device.systemName,
      status: device.status,
      firstConnection: device.firstConnection,
      lastConnection: device.lastConnection,
      lastSeen: device.lastSeen,
      metadata: device.metadata || {}
    };
    
    // Return success
    res.json({
      success: true,
      device: filteredDevice
    });
  } catch (error) {
    // Specific error for device not found
    if (error.message && error.message.includes('Device not found')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    logger.error('Error getting device:', error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving device"
    });
  }
};

/**
 * Get device health
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getDeviceHealth = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { date, limit } = req.query;
    
    // Validate device exists
    try {
      await deviceManager.getDeviceById(deviceId);
    } catch (err) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${deviceId}`
      });
    }
    
    // Get health data
    const healthData = await healthMonitor.getDeviceHealth(deviceId, {
      date,
      limit: limit ? parseInt(limit, 10) : undefined
    });
    
    // Return success
    res.json({
      success: true,
      ...healthData
    });
  } catch (error) {
    logger.error('Error getting device health:', error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving device health"
    });
  }
};

/**
 * Get device logs
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getDeviceLogs = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { date, limit } = req.query;
    
    // Validate device exists
    try {
      await deviceManager.getDeviceById(deviceId);
    } catch (err) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${deviceId}`
      });
    }
    
    // Get logs
    const logs = await deviceManager.getDeviceLogs(deviceId, {
      date,
      limit: limit ? parseInt(limit, 10) : undefined
    });
    
    // Return success
    res.json({
      success: true,
      logs
    });
  } catch (error) {
    logger.error('Error getting device logs:', error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving device logs"
    });
  }
};

/**
 * Initiate connection to device
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.initiateConnection = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const userId = req.user.id;
    
    // Validate device exists and is online
    let device;
    try {
      device = await deviceManager.getDeviceById(deviceId);
      
      if (device.status !== 'online') {
        return res.status(400).json({
          success: false,
          message: `Device is not online (current status: ${device.status})`
        });
      }
    } catch (err) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${deviceId}`
      });
    }
    
    // Generate request ID
    const requestId = uuidv4();
    
    // Log connection request
    await deviceManager.logConnectionRequest({
      deviceId,
      userId,
      requestId,
      timestamp: new Date()
    });
    
    // Return connection info
    res.json({
      success: true,
      requestId,
      deviceId,
      systemName: device.systemName,
      status: device.status,
      message: "Connection request initiated. Use WebSocket API to establish connection."
    });
  } catch (error) {
    logger.error('Error initiating connection:', error);
    res.status(500).json({
      success: false,
      message: "Server error initiating connection"
    });
  }
};

/**
 * Get system health overview
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getSystemHealth = async (req, res) => {
  try {
    const { date } = req.query;
    
    // Get health data
    const healthData = await healthMonitor.getSystemHealth({ date });
    
    // Return success
    res.json({
      success: true,
      ...healthData
    });
  } catch (error) {
    logger.error('Error getting system health:', error);
    res.status(500).json({
      success: false,
      message: "Server error retrieving system health"
    });
  }
};