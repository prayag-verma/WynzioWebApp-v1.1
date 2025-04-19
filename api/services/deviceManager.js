/**
 * Device Manager Service
 * Handles device registration, status tracking, and data management
 */
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');
const config = require('../../config/app');

// Constants
const DEVICE_DATA_DIR = path.join(__dirname, '../../data/devices');
const DEVICE_LOGS_DIR = path.join(__dirname, '../../data/logs');

// Ensure data directories exist
async function initializeDirectories() {
  try {
    await fs.mkdir(DEVICE_DATA_DIR, { recursive: true });
    await fs.mkdir(DEVICE_LOGS_DIR, { recursive: true });
    logger.info('Device data directories initialized');
  } catch (error) {
    logger.error('Error creating data directories:', error);
    throw error;
  }
}

// Initialize on module load
initializeDirectories().catch(err => {
  logger.error('Failed to initialize device manager:', err);
});

/**
 * In-memory device cache for faster access
 * Maps deviceId to device data object
 */
const deviceCache = new Map();

/**
 * Register a new device or update existing one
 * @param {Object} deviceData - Device information
 * @returns {Promise<Object>} Registered device data
 */
async function registerDevice(deviceData) {
  try {
    const { deviceId, systemName, status, apiKey } = deviceData;
    
    // Create device data object
    const device = {
      deviceId,
      systemName,
      status: status || 'online',
      firstConnection: new Date().toISOString(),
      lastConnection: new Date().toISOString(),
      connections: 0,
      metadata: {
        ...deviceData.metadata
      }
    };
    
    // Get existing device data if available
    let existingDevice = null;
    try {
      existingDevice = await getDeviceById(deviceId);
    } catch (err) {
      // No existing device, continue with registration
    }
    
    if (existingDevice) {
      // Merge with existing data
      device.firstConnection = existingDevice.firstConnection;
      device.connections = (existingDevice.connections || 0) + 1;
      device.metadata = {
        ...existingDevice.metadata,
        ...deviceData.metadata
      };
    }
    
    // Save to filesystem
    const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
    await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2));
    
    // Update cache
    deviceCache.set(deviceId, device);
    
    logger.info(`Device registered/updated: ${deviceId}`);
    return device;
  } catch (error) {
    logger.error(`Error registering device: ${error.message}`);
    throw error;
  }
}

/**
 * Get a device by ID
 * @param {String} deviceId - Device identifier
 * @returns {Promise<Object>} Device data
 */
async function getDeviceById(deviceId) {
  // Check cache first
  if (deviceCache.has(deviceId)) {
    return deviceCache.get(deviceId);
  }
  
  try {
    const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
    const data = await fs.readFile(deviceFilePath, 'utf8');
    const device = JSON.parse(data);
    
    // Update cache
    deviceCache.set(deviceId, device);
    
    return device;
  } catch (error) {
    logger.error(`Error retrieving device ${deviceId}: ${error.message}`);
    throw new Error(`Device not found: ${deviceId}`);
  }
}

/**
 * Get all registered devices
 * @returns {Promise<Array>} List of all devices
 */
async function getAllDevices() {
  try {
    const files = await fs.readdir(DEVICE_DATA_DIR);
    const deviceFiles = files.filter(file => file.endsWith('.json'));
    
    const devices = await Promise.all(
      deviceFiles.map(async (file) => {
        try {
          const data = await fs.readFile(path.join(DEVICE_DATA_DIR, file), 'utf8');
          return JSON.parse(data);
        } catch (err) {
          logger.warn(`Error parsing device file ${file}: ${err.message}`);
          return null;
        }
      })
    );
    
    return devices.filter(device => device !== null);
  } catch (error) {
    logger.error(`Error retrieving all devices: ${error.message}`);
    throw error;
  }
}

/**
 * Get all online devices
 * @returns {Promise<Array>} List of online devices
 */
async function getOnlineDevices() {
  try {
    const allDevices = await getAllDevices();
    return allDevices.filter(device => device.status === 'online');
  } catch (error) {
    logger.error(`Error retrieving online devices: ${error.message}`);
    throw error;
  }
}

/**
 * Update device status
 * @param {String} deviceId - Device identifier
 * @param {String} status - New status (online, offline, idle)
 * @returns {Promise<Object>} Updated device data
 */
async function updateDeviceStatus(deviceId, status) {
  try {
    // Get current device data
    let device;
    try {
      device = await getDeviceById(deviceId);
    } catch (err) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    
    // Update status
    device.status = status;
    device.lastStatusChange = new Date().toISOString();
    
    // Save to filesystem
    const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
    await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2));
    
    // Update cache
    deviceCache.set(deviceId, device);
    
    logger.info(`Device ${deviceId} status updated to ${status}`);
    return device;
  } catch (error) {
    logger.error(`Error updating device status: ${error.message}`);
    throw error;
  }
}

/**
 * Update device last seen timestamp
 * @param {String} deviceId - Device identifier
 * @returns {Promise<Object>} Updated device data
 */
async function updateDeviceLastSeen(deviceId) {
  try {
    // Get current device data
    let device;
    try {
      device = await getDeviceById(deviceId);
    } catch (err) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    
    // Update last seen timestamp
    device.lastSeen = new Date().toISOString();
    
    // Save to filesystem
    const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
    await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2));
    
    // Update cache
    deviceCache.set(deviceId, device);
    
    return device;
  } catch (error) {
    logger.error(`Error updating device last seen: ${error.message}`);
    throw error;
  }
}

/**
 * Log a connection request
 * @param {Object} logData - Log data
 * @returns {Promise<Object>} Log entry
 */
async function logConnectionRequest(logData) {
  try {
    const { deviceId, userId, requestId } = logData;
    
    // Create log entry
    const logEntry = {
      id: requestId || uuidv4(),
      deviceId,
      userId,
      timestamp: new Date().toISOString(),
      action: 'connection_request',
      details: {
        ...logData
      }
    };
    
    // Create device logs directory if needed
    const deviceLogDir = path.join(DEVICE_LOGS_DIR, deviceId);
    await fs.mkdir(deviceLogDir, { recursive: true });
    
    // Save log entry
    const logFilePath = path.join(
      deviceLogDir, 
      `${new Date().toISOString().split('T')[0]}.json`
    );
    
    // Check if log file exists
    let logs = [];
    try {
      const existingData = await fs.readFile(logFilePath, 'utf8');
      logs = JSON.parse(existingData);
    } catch (err) {
      // File doesn't exist or is invalid, use empty array
    }
    
    // Add new log entry
    logs.push(logEntry);
    
    // Save updated logs
    await fs.writeFile(logFilePath, JSON.stringify(logs, null, 2));
    
    logger.info(`Connection request logged: ${deviceId} from ${userId}`);
    return logEntry;
  } catch (error) {
    logger.error(`Error logging connection request: ${error.message}`);
    throw error;
  }
}

/**
 * Get device connection logs
 * @param {String} deviceId - Device identifier
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Log entries
 */
async function getDeviceLogs(deviceId, options = {}) {
  try {
    const { date, limit } = options;
    
    // Create device logs directory path
    const deviceLogDir = path.join(DEVICE_LOGS_DIR, deviceId);
    
    // Ensure directory exists
    try {
      await fs.access(deviceLogDir);
    } catch (err) {
      return []; // No logs directory, return empty array
    }
    
    // Get log files
    const files = await fs.readdir(deviceLogDir);
    const logFiles = files.filter(file => file.endsWith('.json'));
    
    // Filter by date if specified
    let filteredFiles = logFiles;
    if (date) {
      filteredFiles = logFiles.filter(file => file.startsWith(date));
    }
    
    // Sort files by date (newest first)
    filteredFiles.sort().reverse();
    
    // Read log files
    const logs = [];
    for (const file of filteredFiles) {
      const data = await fs.readFile(path.join(deviceLogDir, file), 'utf8');
      const fileEntries = JSON.parse(data);
      logs.push(...fileEntries);
      
      if (limit && logs.length >= limit) {
        break;
      }
    }
    
    // Apply limit if specified
    return limit ? logs.slice(0, limit) : logs;
  } catch (error) {
    logger.error(`Error retrieving device logs: ${error.message}`);
    throw error;
  }
}

/**
 * Validate API key
 * @param {String} apiKey - API key to validate
 * @returns {Promise<Boolean>} Whether the API key is valid
 */
async function validateApiKey(apiKey) {
  try {
    // If no API key, return false
    if (!apiKey) {
      return false;
    }
    
    // Check against configured API key
    return apiKey === config.deviceApiKey;
  } catch (error) {
    logger.error(`Error validating API key: ${error.message}`);
    return false;
  }
}

module.exports = {
  registerDevice,
  getDeviceById,
  getAllDevices,
  getOnlineDevices,
  updateDeviceStatus,
  updateDeviceLastSeen,
  logConnectionRequest,
  getDeviceLogs,
  validateApiKey
};