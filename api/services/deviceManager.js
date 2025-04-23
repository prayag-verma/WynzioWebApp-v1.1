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
// Match Windows app expectations (ConnectionSettings.cs reconnect intervals)
const OFFLINE_THRESHOLD = 300000; // 5 minutes (300000ms) - matches Windows app
const IDLE_THRESHOLD = 60000;     // 1 minute (60000ms) - matches Windows app

// Singleton instance
let instance = null;

class DeviceManager {
  constructor() {
    // In-memory device cache for faster access
    this.deviceCache = new Map();
    this.initializeDirectories();
  }

  /**
   * Ensure data directories exist
   */
  async initializeDirectories() {
    try {
      await fs.mkdir(DEVICE_DATA_DIR, { recursive: true });
      await fs.mkdir(DEVICE_LOGS_DIR, { recursive: true });
      logger.info('Device data directories initialized');
    } catch (error) {
      logger.error('Error creating data directories:', error);
      throw error;
    }
  }

  /**
   * Register a new device or update existing one
   * @param {Object} deviceData - Device information
   * @returns {Promise<Object>} Registered device data
   */
  async registerDevice(deviceData) {
    try {
      // Extract required fields - allow for multiple formats from Windows app
      const deviceId = deviceData.deviceId || deviceData.hostId;
      const systemName = deviceData.systemName || 'Unknown Device';
      const status = deviceData.status || 'online';
      const apiKey = deviceData.apiKey;
      const metadata = deviceData.metadata || {};
      
      // Basic validation
      if (!deviceId) {
        throw new Error('Missing required device information: deviceId/hostId');
      }
      
      // Create device data object
      const device = {
        deviceId,
        systemName,
        status,
        firstConnection: new Date().toISOString(),
        lastConnection: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastStatusChange: new Date().toISOString(),
        connections: 0,
        metadata
      };
      
      // Get existing device data if available
      let existingDevice = null;
      try {
        existingDevice = await this.getDeviceById(deviceId);
      } catch (err) {
        // No existing device, continue with registration
      }
      
      if (existingDevice) {
        // Merge with existing data
        device.firstConnection = existingDevice.firstConnection;
        device.connections = (existingDevice.connections || 0) + 1;
        
        // Keep existing lastStatusChange if status hasn't changed
        if (existingDevice.status === status) {
          device.lastStatusChange = existingDevice.lastStatusChange;
        }
        
        // Merge metadata, keeping existing values if not updated
        device.metadata = {
          ...existingDevice.metadata,
          ...metadata
        };
      }
      
      // Save to filesystem
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
      await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2));
      
      // Update cache
      this.deviceCache.set(deviceId, device);
      
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
  async getDeviceById(deviceId) {
    // Check cache first
    if (this.deviceCache.has(deviceId)) {
      return this.deviceCache.get(deviceId);
    }
    
    try {
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
      const data = await fs.readFile(deviceFilePath, 'utf8');
      const device = JSON.parse(data);
      
      // Update cache
      this.deviceCache.set(deviceId, device);
      
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
  async getAllDevices() {
    try {
        const files = await fs.readdir(DEVICE_DATA_DIR);
        const deviceFiles = files.filter(file => file.endsWith('.json'));
        
        // Special handling for test data
        if (deviceFiles.includes('test-devices.json')) {
            try {
                const data = await fs.readFile(path.join(DEVICE_DATA_DIR, 'test-devices.json'), 'utf8');
                const testDevices = JSON.parse(data);
                logger.debug('Found test devices:', testDevices.length);
                return testDevices;
            } catch (testErr) {
                logger.error('Error parsing test devices:', testErr);
                // Continue with normal device loading if test data fails
            }
        }
        
        const devices = await Promise.all(
            deviceFiles.map(async (file) => {
                // Skip the test-devices.json file in normal processing
                if (file === 'test-devices.json') return null;
                
                try {
                    const data = await fs.readFile(path.join(DEVICE_DATA_DIR, file), 'utf8');
                    const device = JSON.parse(data);
                    
                    // Ensure required fields exist to prevent frontend errors
                    if (!device.status) device.status = 'unknown';
                    if (!device.systemName) device.systemName = 'Unknown Device';
                    if (!device.lastSeen) device.lastSeen = device.lastConnection || new Date().toISOString();
                    if (!device.lastConnection) device.lastConnection = device.lastSeen || new Date().toISOString();
                    if (!device.lastStatusChange) device.lastStatusChange = device.lastConnection || new Date().toISOString();
                    
                    // Update cache with clean data
                    this.deviceCache.set(device.deviceId, device);
                    
                    return device;
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
  async getOnlineDevices() {
    try {
      const allDevices = await this.getAllDevices();
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
  async updateDeviceStatus(deviceId, status) {
    try {
      // Get current device data
      let device;
      try {
        device = await this.getDeviceById(deviceId);
      } catch (err) {
        throw new Error(`Device not found: ${deviceId}`);
      }
      
      // Skip if status hasn't changed
      if (device.status === status) {
        return device;
      }
      
      // Update status
      device.status = status;
      device.lastStatusChange = new Date().toISOString();
      
      // If status is 'online', also update lastSeen
      if (status === 'online') {
        device.lastSeen = new Date().toISOString();
      }
      
      // Log status change
      logger.info(`Device ${deviceId} status changed from ${device.status} to ${status}`);
      
      // Save to filesystem
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
      await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2));
      
      // Update cache
      this.deviceCache.set(deviceId, device);
      
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
  async updateDeviceLastSeen(deviceId) {
    try {
      // Get current device data
      let device;
      try {
        device = await this.getDeviceById(deviceId);
      } catch (err) {
        throw new Error(`Device not found: ${deviceId}`);
      }
      
      // Update last seen timestamp
      const now = new Date();
      device.lastSeen = now.toISOString();
      
      // Check if status needs updating based on current status
      let statusChanged = false;
      if (device.status === 'offline' || device.status === 'idle') {
        device.status = 'online';
        device.lastStatusChange = now.toISOString();
        statusChanged = true;
        logger.info(`Device ${deviceId} status changed to online (due to activity)`);
      }
      
      // Save to filesystem
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${deviceId}.json`);
      await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2));
      
      // Update cache
      this.deviceCache.set(deviceId, device);
      
      return device;
    } catch (error) {
      logger.error(`Error updating device last seen: ${error.message}`);
      throw error;
    }
  }

  /**
   * Auto-detect device status based on last seen time
   * @param {String} deviceId - Device identifier
   * @returns {Promise<Object>} Updated device data with correct status
   */
  async detectDeviceStatus(deviceId) {
    try {
      // Get current device data
      let device;
      try {
        device = await this.getDeviceById(deviceId);
      } catch (err) {
        throw new Error(`Device not found: ${deviceId}`);
      }
      
      // Calculate time since last seen
      const lastSeen = new Date(device.lastSeen || device.lastConnection);
      const now = new Date();
      const timeSinceLastSeen = now - lastSeen;
      
      // Determine status based on thresholds
      let newStatus = device.status;
      
      if (timeSinceLastSeen > OFFLINE_THRESHOLD) {
        newStatus = 'offline';
      } else if (timeSinceLastSeen > IDLE_THRESHOLD) {
        newStatus = 'idle';
      } else {
        newStatus = 'online';
      }
      
      // Only update if status has changed
      if (newStatus !== device.status) {
        return await this.updateDeviceStatus(deviceId, newStatus);
      }
      
      return device;
    } catch (error) {
      logger.error(`Error detecting device status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Log a connection request
   * @param {Object} logData - Log data
   * @returns {Promise<Object>} Log entry
   */
  async logConnectionRequest(logData) {
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
  async getDeviceLogs(deviceId, options = {}) {
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
  async validateApiKey(apiKey) {
    try {
      // If no API key, return false
      if (!apiKey) {
        return false;
      }
      
      // Compare with configured API key from config, handling multiple formats
      const configuredKey = config.deviceApiKey;
      
      // Direct match
      if (apiKey === configuredKey) {
        return true;
      }
      
      // Check if formatted as "ApiKey XXXX"
      if (apiKey.startsWith('ApiKey ') && apiKey.substring(7) === configuredKey) {
        return true;
      }
      
      // Check if configuredKey is formatted as "ApiKey XXXX" but apiKey is not
      if (configuredKey.startsWith('ApiKey ') && configuredKey.substring(7) === apiKey) {
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error(`Error validating API key: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up old device data
   * @param {Number} days - Number of days to keep data for
   * @returns {Promise<Number>} Number of devices cleaned up
   */
  async cleanupOldDevices(days = 90) {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      
      const allDevices = await this.getAllDevices();
      let cleanedCount = 0;
      
      for (const device of allDevices) {
        const lastSeen = new Date(device.lastSeen || device.lastConnection);
        
        // If device hasn't been seen since cutoff, remove it
        if (lastSeen < cutoff) {
          const deviceFilePath = path.join(DEVICE_DATA_DIR, `${device.deviceId}.json`);
          await fs.unlink(deviceFilePath);
          
          // Remove from cache
          this.deviceCache.delete(device.deviceId);
          
          logger.info(`Cleaned up old device: ${device.deviceId} (last seen: ${lastSeen.toISOString()})`);
          cleanedCount++;
        }
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error(`Error cleaning up old devices: ${error.message}`);
      throw error;
    }
  }
}

// Create and export singleton instance
module.exports = (function() {
  if (!instance) {
    instance = new DeviceManager();
  }
  return instance;
})();