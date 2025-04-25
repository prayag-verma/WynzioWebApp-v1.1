/**
 * Device Controller
 * Handles API endpoints for device management
 * Updated to fix undefined remotePcId error
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
    // Extract remotePcId from request - this is the only identifier used in Windows app
    const remotePcId = req.body.remotePcId;
    const systemName = req.body.systemName;
    const apiKey = req.body.apiKey;
    const metadata = req.body.metadata || {};
    
    // Validate required fields
    if (!remotePcId || !systemName || !apiKey) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: remotePcId, systemName, apiKey"
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
      remotePcId,
      systemName,
      status: 'online',
      apiKey,
      metadata: metadata
    });
    
    // Return success with expected response format
    res.json({
      success: true,
      device: {
        remotePcId: device.remotePcId,
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
      remotePcId: device.remotePcId,
      systemName: device.systemName,
      status: device.status || 'unknown',
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
      remotePcId: device.remotePcId,
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
 * Get device by remotePcId
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.getDeviceById = async (req, res) => {
  try {
    const { remotePcId } = req.params;
    
    // CRITICAL FIX: Add validation for remotePcId
    if (!remotePcId) {
      return res.status(404).json({
        success: false,
        message: "Device ID is missing or undefined"
      });
    }
    
    // Get device
    const device = await deviceManager.getDeviceByRemotePcId(remotePcId);
    
    // Filter sensitive data
    const filteredDevice = {
      remotePcId: device.remotePcId,
      systemName: device.systemName,
      status: device.status || 'unknown',
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
 * Update device status
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
exports.updateDeviceStatus = async (req, res) => {
  try {
    const { remotePcId } = req.params;
    const { status } = req.body;
    
    // CRITICAL FIX: Add validation for remotePcId
    if (!remotePcId) {
      return res.status(404).json({
        success: false,
        message: "Device ID is missing or undefined"
      });
    }
    
    // Validate status
    if (!status || !['online', 'offline', 'idle'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Must be online, offline, or idle."
      });
    }
    
    // Update device status
    const updatedDevice = await deviceManager.updateDeviceStatus(remotePcId, status);
    
    // Return success
    res.json({
      success: true,
      device: {
        remotePcId: updatedDevice.remotePcId,
        status: updatedDevice.status,
        lastStatusChange: updatedDevice.lastStatusChange
      }
    });
  } catch (error) {
    // Specific error for device not found
    if (error.message && error.message.includes('Device not found')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    logger.error('Error updating device status:', error);
    res.status(500).json({
      success: false,
      message: "Server error updating device status"
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
    const { remotePcId } = req.params;
    const { date, limit } = req.query;
    
    // CRITICAL FIX: Add validation for remotePcId
    if (!remotePcId) {
      return res.status(404).json({
        success: false,
        message: "Device ID is missing or undefined"
      });
    }
    
    // Validate device exists
    try {
      await deviceManager.getDeviceByRemotePcId(remotePcId);
    } catch (err) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${remotePcId}`
      });
    }
    
    // Get health data
    const healthData = await healthMonitor.getDeviceHealth(remotePcId, {
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
    const { remotePcId } = req.params;
    const { date, limit } = req.query;
    
    // CRITICAL FIX: Add validation for remotePcId
    if (!remotePcId) {
      return res.status(404).json({
        success: false,
        message: "Device ID is missing or undefined"
      });
    }
    
    // Validate device exists
    try {
      await deviceManager.getDeviceByRemotePcId(remotePcId);
    } catch (err) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${remotePcId}`
      });
    }
    
    // Get logs
    const logs = await deviceManager.getDeviceLogs(remotePcId, {
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
    const { remotePcId } = req.params;
    // For testing, make user ID optional
    const userId = req.user ? req.user.id : 'admin-user';
    
    // CRITICAL FIX: Add validation for remotePcId
    if (!remotePcId) {
      return res.status(404).json({
        success: false,
        message: "Device ID is missing or undefined"
      });
    }
    
    // Validate device exists
    let device;
    try {
      device = await deviceManager.getDeviceByRemotePcId(remotePcId);
    } catch (err) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${remotePcId}`
      });
    }
    
    // Generate request ID
    const requestId = uuidv4();
    
    // Log connection request
    await deviceManager.logConnectionRequest({
      remotePcId,
      userId,
      requestId,
      timestamp: new Date()
    });
    
    // Return connection info
    res.json({
      success: true,
      requestId,
      remotePcId,
      systemName: device.systemName,
      status: device.status || 'unknown',
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