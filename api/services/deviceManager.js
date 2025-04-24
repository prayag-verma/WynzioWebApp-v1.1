/**
 * Device Manager Service
 * Handles device registration, status tracking, and data management
 * Modified to use file-based storage for Windows app compatibility
 * Updated to use remotePcId consistently with Windows app
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
      // Extract required fields - use remotePcId consistently with Windows app
      const remotePcId = deviceData.remotePcId;
      const systemName = deviceData.systemName || 'Unknown Device';
      const status = deviceData.status || 'online';
      const apiKey = deviceData.apiKey;
      const metadata = deviceData.metadata || {};
      
      // Basic validation
      if (!remotePcId) {
        throw new Error('Missing required device information: remotePcId');
      }
      
      // Create device data object
      const device = {
        remotePcId,
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
        existingDevice = await this.getDeviceByRemotePcId(remotePcId);
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
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${remotePcId}.json`);
      await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2), 'utf8');
      
      // Update cache
      this.deviceCache.set(remotePcId, device);
      
      // Log successful registration
      if (existingDevice) {
        logger.info(`Device updated: ${remotePcId} (${systemName})`);
      } else {
        logger.info(`Device registered: ${remotePcId} (${systemName})`);
      }
      
      return device;
    } catch (error) {
      logger.error(`Error registering device: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get device by remotePcId
   * @param {string} remotePcId - Device identifier
   * @returns {Promise<Object>} Device data
   */
  async getDeviceByRemotePcId(remotePcId) {
    try {
      // Check cache first
      if (this.deviceCache.has(remotePcId)) {
        return this.deviceCache.get(remotePcId);
      }
      
      // Load from file
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${remotePcId}.json`);
      const data = await fs.readFile(deviceFilePath, 'utf8');
      const device = JSON.parse(data);
      
      // Update cache
      this.deviceCache.set(remotePcId, device);
      
      return device;
    } catch (error) {
      logger.error(`Error getting device: ${error.message}`);
      throw new Error(`Device not found: ${remotePcId}`);
    }
  }

  /**
   * Get all registered devices
   * @returns {Promise<Array>} List of devices
   */
  async getAllDevices() {
    try {
      const deviceFiles = await fs.readdir(DEVICE_DATA_DIR);
      const jsonFiles = deviceFiles.filter(file => file.endsWith('.json'));
      
      const devices = [];
      
      for (const file of jsonFiles) {
        try {
          // Extract remotePcId from filename
          const remotePcId = path.basename(file, '.json');
          
          // Get device data
          const device = await this.getDeviceByRemotePcId(remotePcId);
          devices.push(device);
        } catch (err) {
          // Skip invalid files
          logger.warn(`Skipping invalid device file: ${file}`);
        }
      }
      
      return devices;
    } catch (error) {
      logger.error(`Error getting all devices: ${error.message}`);
      return [];
    }
  }

  /**
   * Get online devices
   * @returns {Promise<Array>} List of online devices
   */
  async getOnlineDevices() {
    try {
      const devices = await this.getAllDevices();
      return devices.filter(device => device.status === 'online');
    } catch (error) {
      logger.error(`Error getting online devices: ${error.message}`);
      return [];
    }
  }

  /**
   * Update device status
   * @param {string} remotePcId - Device identifier
   * @param {string} status - New status ('online', 'offline', 'idle')
   * @returns {Promise<Object>} Updated device data
   */
  async updateDeviceStatus(remotePcId, status) {
    try {
      // Validate status
      if (!['online', 'offline', 'idle'].includes(status)) {
        throw new Error('Invalid status value. Must be online, offline, or idle.');
      }
      
      // Get current device data
      const device = await this.getDeviceByRemotePcId(remotePcId);
      
      // Skip update if status hasn't changed
      if (device.status === status) {
        return device;
      }
      
      // Update status and timestamps
      device.status = status;
      device.lastStatusChange = new Date().toISOString();
      
      // If status is 'online', update lastSeen
      if (status === 'online') {
        device.lastSeen = new Date().toISOString();
      }
      
      // Save to filesystem
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${remotePcId}.json`);
      await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2), 'utf8');
      
      // Update cache
      this.deviceCache.set(remotePcId, device);
      
      logger.info(`Device ${remotePcId} status changed to ${status}`);
      
      return device;
    } catch (error) {
      logger.error(`Error updating device status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update device last seen timestamp
   * @param {string} remotePcId - Device identifier
   * @returns {Promise<Object>} Updated device data
   */
  async updateDeviceLastSeen(remotePcId) {
    try {
      // Get current device data
      const device = await this.getDeviceByRemotePcId(remotePcId);
      
      // Update lastSeen timestamp
      device.lastSeen = new Date().toISOString();
      
      // Save to filesystem
      const deviceFilePath = path.join(DEVICE_DATA_DIR, `${remotePcId}.json`);
      await fs.writeFile(deviceFilePath, JSON.stringify(device, null, 2), 'utf8');
      
      // Update cache
      this.deviceCache.set(remotePcId, device);
      
      return device;
    } catch (error) {
      logger.error(`Error updating device last seen: ${error.message}`);
      throw error;
    }
  }

  /**
   * Detect device status based on last seen time
   * @param {string} remotePcId - Device identifier
   * @returns {Promise<string>} Detected status
   */
  async detectDeviceStatus(remotePcId) {
    try {
      // Get current device data
      const device = await this.getDeviceByRemotePcId(remotePcId);
      
      // Calculate time since last seen
      const lastSeen = new Date(device.lastSeen);
      const now = new Date();
      const timeSinceLastSeen = now - lastSeen;
      
      // Determine status based on thresholds - aligned with Windows app
      let newStatus = device.status;
      
      if (timeSinceLastSeen > OFFLINE_THRESHOLD) {
        newStatus = 'offline';
      } else if (timeSinceLastSeen > IDLE_THRESHOLD) {
        newStatus = 'idle';
      } else {
        newStatus = 'online';
      }
      
      // Update status if changed
      if (newStatus !== device.status) {
        await this.updateDeviceStatus(remotePcId, newStatus);
      }
      
      return newStatus;
    } catch (error) {
      logger.error(`Error detecting device status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validate API key
   * @param {string} apiKey - API key to validate
   * @returns {Promise<boolean>} Whether the API key is valid
   */
  async validateApiKey(apiKey) {
    try {
      // Normalize keys for comparison to match the Windows app exactly
      const expectedKey = config.remoteApiKey.replace('ApiKey ', '');
      
      // Handle incoming formats consistently with Windows app
      let normalizedKey = apiKey;
      
      // Remove 'ApiKey ' prefix if present
      if (normalizedKey && normalizedKey.startsWith('ApiKey ')) {
        normalizedKey = normalizedKey.substring(7);
      }
      
      // Compare normalized values
      return normalizedKey === expectedKey;
    } catch (error) {
      logger.error(`Error validating API key: ${error.message}`);
      return false;
    }
  }

  /**
   * Log connection request
   * @param {Object} requestData - Connection request data
   * @returns {Promise<Object>} Logged request data
   */
  async logConnectionRequest(requestData) {
    try {
      const { remotePcId, userId, requestId, timestamp } = requestData;
      
      // Create log entry
      const logEntry = {
        id: requestId || uuidv4(),
        remotePcId,
        userId,
        timestamp: timestamp || new Date().toISOString(),
        type: 'connection-request'
      };
      
      // Get log file path
      const today = new Date().toISOString().split('T')[0];
      const logFilePath = path.join(DEVICE_LOGS_DIR, `${remotePcId}_${today}.json`);
      
      // Read existing logs or create new array
      let logs = [];
      try {
        const data = await fs.readFile(logFilePath, 'utf8');
        logs = JSON.parse(data);
      } catch (err) {
        // File doesn't exist or invalid JSON, start with empty array
      }
      
      // Add new log entry
      logs.push(logEntry);
      
      // Save logs
      await fs.writeFile(logFilePath, JSON.stringify(logs, null, 2), 'utf8');
      
      return logEntry;
    } catch (error) {
      logger.error(`Error logging connection request: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get device logs
   * @param {string} remotePcId - Device identifier
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Device logs
   */
  async getDeviceLogs(remotePcId, options = {}) {
    try {
      const { date, limit } = options;
      
      // Determine which date to use
      const targetDate = date || new Date().toISOString().split('T')[0];
      const logFilePath = path.join(DEVICE_LOGS_DIR, `${remotePcId}_${targetDate}.json`);
      
      // Read log file
      let logs = [];
      try {
        const data = await fs.readFile(logFilePath, 'utf8');
        logs = JSON.parse(data);
      } catch (err) {
        // File doesn't exist or invalid JSON, return empty array
        return [];
      }
      
      // Apply limit if specified
      if (limit && limit > 0) {
        logs = logs.slice(-limit);
      }
      
      return logs;
    } catch (error) {
      logger.error(`Error getting device logs: ${error.message}`);
      return [];
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