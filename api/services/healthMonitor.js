/**
 * Health Monitor Service
 * Monitors device health and connectivity status
 * Updated for file-based storage and Windows app compatibility
 * Changed to use remotePcId consistently with Windows app
 */
const fs = require('fs').promises;
const path = require('path');
const logger = require('../../utils/logger');
const deviceManager = require('./deviceManager');

// Constants
const HEALTH_DATA_DIR = path.join(__dirname, '../../data/health');
const MONITOR_INTERVAL = 60000; // 1 minute
// Status thresholds aligned exactly with Windows app (ConnectionSettings.cs)
const STATUS_THRESHOLDS = {
  OFFLINE: 300000, // 5 minutes (300000ms) - matches Windows app setting
  IDLE: 60000      // 1 minute (60000ms) - matches Windows app setting
};

// Ensure health data directory exists
async function initializeDirectory() {
  try {
    await fs.mkdir(HEALTH_DATA_DIR, { recursive: true });
    logger.info('Health data directory initialized');
  } catch (error) {
    logger.error('Error creating health data directory:', error);
    throw error;
  }
}

// Initialize on module load
initializeDirectory().catch(err => {
  logger.error('Failed to initialize health monitor:', err);
});

// Store monitoring timers
const monitoringTimers = new Map();

/**
 * Start health monitoring service
 * @param {Object} io - Socket.IO instance for notifications
 */
function startMonitoring(io) {
  // Clear any existing timer
  if (monitoringTimers.has('global')) {
    clearInterval(monitoringTimers.get('global'));
  }
  
  // Start global monitoring interval
  const timerId = setInterval(() => monitorAllDevices(io), MONITOR_INTERVAL);
  monitoringTimers.set('global', timerId);
  
  logger.info('Health monitoring service started with thresholds: offline=' + 
              (STATUS_THRESHOLDS.OFFLINE/1000) + 's, idle=' + 
              (STATUS_THRESHOLDS.IDLE/1000) + 's');
}

/**
 * Stop health monitoring service
 */
function stopMonitoring() {
  // Clear all timers
  for (const [key, timerId] of monitoringTimers.entries()) {
    clearInterval(timerId);
  }
  
  monitoringTimers.clear();
  logger.info('Health monitoring service stopped');
}

/**
 * Monitor all registered devices
 * @param {Object} io - Socket.IO instance for notifications
 */
async function monitorAllDevices(io) {
  try {
    const devices = await deviceManager.getAllDevices();
    
    // Process each device
    for (const device of devices) {
      try {
        await checkDeviceHealth(device, io);
      } catch (err) {
        logger.error(`Error checking device ${device.remotePcId} health:`, err);
      }
    }
    
    // Save monitoring summary
    await saveMonitoringSummary(devices);
  } catch (error) {
    logger.error('Error in device monitoring cycle:', error);
  }
}

/**
 * Check health of a specific device
 * @param {Object} device - Device data
 * @param {Object} io - Socket.IO instance for notifications
 */
async function checkDeviceHealth(device, io) {
  const now = new Date();
  let newStatus = device.status;
  let statusChanged = false;
  
  // Skip if device has no last seen timestamp
  if (!device.lastSeen) {
    return;
  }
  
  const lastSeen = new Date(device.lastSeen);
  const timeSinceLastSeen = now - lastSeen;
  
  // Determine new status based on thresholds
  if (timeSinceLastSeen > STATUS_THRESHOLDS.OFFLINE) {
    if (device.status !== 'offline') {
      newStatus = 'offline';
      statusChanged = true;
    }
  } else if (timeSinceLastSeen > STATUS_THRESHOLDS.IDLE) {
    if (device.status !== 'idle') {
      newStatus = 'idle';
      statusChanged = true;
    }
  } else if (device.status !== 'online') {
    // Device was offline/idle but has been seen recently
    newStatus = 'online';
    statusChanged = true;
  }
  
  // Update status if changed
  if (statusChanged) {
    await deviceManager.updateDeviceStatus(device.remotePcId, newStatus);
    
    // Log status change
    logger.info(`Device ${device.remotePcId} status changed: ${device.status} -> ${newStatus}`);
    
    // Notify clients if io provided
    if (io) {
      io.emit('device-status-update', {
        remotePcId: device.remotePcId,
        status: newStatus,
        timestamp: now.toISOString()
      });
    }
    
    // Record health event
    await recordHealthEvent(device.remotePcId, {
      type: 'status_change',
      oldStatus: device.status,
      newStatus,
      timestamp: now.toISOString()
    });
  }
}

/**
 * Record health event for a device
 * @param {String} remotePcId - Device identifier
 * @param {Object} event - Event data
 */
async function recordHealthEvent(remotePcId, event) {
  try {
    // Create device health directory if needed
    const deviceHealthDir = path.join(HEALTH_DATA_DIR, remotePcId);
    await fs.mkdir(deviceHealthDir, { recursive: true });
    
    // Build log file path with current date
    const today = new Date().toISOString().split('T')[0];
    const logFilePath = path.join(deviceHealthDir, `${today}.json`);
    
    // Load existing events or create new array
    let events = [];
    try {
      const data = await fs.readFile(logFilePath, 'utf8');
      events = JSON.parse(data);
    } catch (err) {
      // File doesn't exist or invalid JSON, start with empty array
    }
    
    // Add new event
    events.push(event);
    
    // Save updated events
    await fs.writeFile(logFilePath, JSON.stringify(events, null, 2));
  } catch (error) {
    logger.error(`Error recording health event for ${remotePcId}:`, error);
  }
}

/**
 * Save monitoring summary
 * @param {Array} devices - All devices
 */
async function saveMonitoringSummary(devices) {
  try {
    // Create summary
    const summary = {
      timestamp: new Date().toISOString(),
      totalDevices: devices.length,
      onlineDevices: devices.filter(d => d.status === 'online').length,
      idleDevices: devices.filter(d => d.status === 'idle').length,
      offlineDevices: devices.filter(d => d.status === 'offline').length
    };
    
    // Save summary to file
    const today = new Date().toISOString().split('T')[0];
    const summaryFilePath = path.join(HEALTH_DATA_DIR, `summary_${today}.json`);
    
    // Load existing summaries or create new array
    let summaries = [];
    try {
      const data = await fs.readFile(summaryFilePath, 'utf8');
      summaries = JSON.parse(data);
    } catch (err) {
      // File doesn't exist or invalid JSON, start with empty array
    }
    
    // Add new summary
    summaries.push(summary);
    
    // Save updated summaries (keep only last 1440 entries - 24 hours at 1 min intervals)
    if (summaries.length > 1440) {
      summaries = summaries.slice(-1440);
    }
    
    await fs.writeFile(summaryFilePath, JSON.stringify(summaries, null, 2));
  } catch (error) {
    logger.error('Error saving monitoring summary:', error);
  }
}

/**
 * Get device health data
 * @param {String} remotePcId - Device identifier
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Health data
 */
async function getDeviceHealth(remotePcId, options = {}) {
  try {
    const { date, limit } = options;
    const deviceHealthDir = path.join(HEALTH_DATA_DIR, remotePcId);
    
    // Check if health data directory exists
    try {
      await fs.access(deviceHealthDir);
    } catch (err) {
      return { events: [] }; // No health data, return empty events
    }
    
    // Get event files
    const files = await fs.readdir(deviceHealthDir);
    const eventFiles = files.filter(file => file.endsWith('.json'));
    
    // Filter by date if specified
    let filteredFiles = eventFiles;
    if (date) {
      filteredFiles = eventFiles.filter(file => file.startsWith(date));
    } else {
      // Get latest file
      filteredFiles.sort().reverse();
      filteredFiles = filteredFiles.slice(0, 1);
    }
    
    // Read event files
    const events = [];
    for (const file of filteredFiles) {
      const data = await fs.readFile(path.join(deviceHealthDir, file), 'utf8');
      const fileEvents = JSON.parse(data);
      events.push(...fileEvents);
    }
    
    // Apply limit if specified
    const limitedEvents = limit ? events.slice(0, limit) : events;
    
    // Get current device data
    let device;
    try {
      device = await deviceManager.getDeviceByRemotePcId(remotePcId);
    } catch (err) {
      device = null;
    }
    
    return {
      device,
      events: limitedEvents
    };
  } catch (error) {
    logger.error(`Error retrieving device health data: ${error.message}`);
    throw error;
  }
}

/**
 * Get system health summary
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Health summary
 */
async function getSystemHealth(options = {}) {
  try {
    const { date } = options;
    
    // Determine which date to use
    const targetDate = date || new Date().toISOString().split('T')[0];
    const summaryFilePath = path.join(HEALTH_DATA_DIR, `summary_${targetDate}.json`);
    
    // Read summary file
    try {
      const data = await fs.readFile(summaryFilePath, 'utf8');
      const summaries = JSON.parse(data);
      
      // Get latest summary
      const latestSummary = summaries[summaries.length - 1];
      
      // Get all devices
      const devices = await deviceManager.getAllDevices();
      
      return {
        timestamp: new Date().toISOString(),
        summary: latestSummary,
        history: summaries,
        devices: devices.map(d => ({
          remotePcId: d.remotePcId,
          systemName: d.systemName,
          status: d.status,
          lastSeen: d.lastSeen
        }))
      };
    } catch (err) {
      // No summary file, return empty data
      return {
        timestamp: new Date().toISOString(),
        summary: {
          totalDevices: 0,
          onlineDevices: 0,
          idleDevices: 0,
          offlineDevices: 0
        },
        history: [],
        devices: []
      };
    }
  } catch (error) {
    logger.error(`Error retrieving system health: ${error.message}`);
    throw error;
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  monitorAllDevices,
  getDeviceHealth,
  getSystemHealth
};