/**
 * Logger utility
 * Simple logging utility with configurable level
 */
const fs = require('fs');
const path = require('path');

// Log levels
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

// Configuration
const config = {
  level: process.env.LOG_LEVEL || 'INFO',
  logToFile: process.env.LOG_TO_FILE !== 'false',
  logDir: process.env.LOG_DIR || path.join(__dirname, '../logs'),
  logFile: process.env.LOG_FILE || 'wynzio-server.log',
  maxLogSize: parseInt(process.env.MAX_LOG_SIZE || '5242880', 10), // 5MB default
  maxLogFiles: parseInt(process.env.MAX_LOG_FILES || '5', 10)
};

// Ensure log directory exists
if (config.logToFile) {
  try {
    if (!fs.existsSync(config.logDir)) {
      fs.mkdirSync(config.logDir, { recursive: true });
    }
  } catch (error) {
    console.error(`Error creating log directory: ${error.message}`);
    config.logToFile = false;
  }
}

/**
 * Get numeric log level from string
 * @param {string} levelString - Log level string
 * @returns {number} Numeric log level
 */
function getNumericLevel(levelString) {
  const level = LOG_LEVELS[levelString.toUpperCase()];
  return level !== undefined ? level : LOG_LEVELS.INFO;
}

/**
 * Format log message
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {any} data - Additional data to log
 * @returns {string} Formatted log message
 */
function formatLogMessage(level, message, data) {
  const timestamp = new Date().toISOString();
  let logMessage = `[${timestamp}] [${level}] ${message}`;
  
  if (data) {
    if (data instanceof Error) {
      logMessage += `\n${data.stack || data.message}`;
    } else if (typeof data === 'object') {
      try {
        logMessage += `\n${JSON.stringify(data, null, 2)}`;
      } catch (error) {
        logMessage += `\n[Object] ${Object.prototype.toString.call(data)}`;
      }
    } else {
      logMessage += `\n${data}`;
    }
  }
  
  return logMessage;
}

/**
 * Write to log file
 * @param {string} message - Message to log
 */
function writeToFile(message) {
  if (!config.logToFile) return;
  
  const logFilePath = path.join(config.logDir, config.logFile);
  
  try {
    // Check if log file exists and rotate if needed
    if (fs.existsSync(logFilePath)) {
      const stats = fs.statSync(logFilePath);
      
      if (stats.size > config.maxLogSize) {
        rotateLogFiles();
      }
    }
    
    // Append to log file
    fs.appendFileSync(logFilePath, message + '\n', 'utf8');
  } catch (error) {
    console.error(`Error writing to log file: ${error.message}`);
  }
}

/**
 * Rotate log files
 */
function rotateLogFiles() {
  const logFilePath = path.join(config.logDir, config.logFile);
  
  try {
    // Remove oldest log file if max files reached
    const oldestLogFile = path.join(config.logDir, `${config.logFile}.${config.maxLogFiles}`);
    if (fs.existsSync(oldestLogFile)) {
      fs.unlinkSync(oldestLogFile);
    }
    
    // Shift existing log files
    for (let i = config.maxLogFiles - 1; i >= 1; i--) {
      const currentFile = path.join(config.logDir, `${config.logFile}.${i}`);
      const nextFile = path.join(config.logDir, `${config.logFile}.${i + 1}`);
      
      if (fs.existsSync(currentFile)) {
        fs.renameSync(currentFile, nextFile);
      }
    }
    
    // Rename current log file
    if (fs.existsSync(logFilePath)) {
      fs.renameSync(logFilePath, path.join(config.logDir, `${config.logFile}.1`));
    }
  } catch (error) {
    console.error(`Error rotating log files: ${error.message}`);
  }
}

/**
 * Log message
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {any} data - Additional data to log
 */
function log(level, message, data) {
  const numericLevel = getNumericLevel(level);
  const configuredLevel = getNumericLevel(config.level);
  
  if (numericLevel <= configuredLevel) {
    const formattedMessage = formatLogMessage(level, message, data);
    
    // Log to console
    if (level === 'ERROR') {
      console.error(formattedMessage);
    } else if (level === 'WARN') {
      console.warn(formattedMessage);
    } else {
      console.log(formattedMessage);
    }
    
    // Log to file
    writeToFile(formattedMessage);
  }
}

// Logger interface
const logger = {
  error: (message, data) => log('ERROR', message, data),
  warn: (message, data) => log('WARN', message, data),
  info: (message, data) => log('INFO', message, data),
  debug: (message, data) => log('DEBUG', message, data),
  
  // Allow changing log level at runtime
  setLevel: (level) => {
    if (LOG_LEVELS[level.toUpperCase()] !== undefined) {
      config.level = level.toUpperCase();
    }
  },
  
  // Get current log level
  getLevel: () => config.level,
  
  // Get logger for a specific context
  forContext: (context) => {
    return {
      error: (message, data) => log('ERROR', `[${context}] ${message}`, data),
      warn: (message, data) => log('WARN', `[${context}] ${message}`, data),
      info: (message, data) => log('INFO', `[${context}] ${message}`, data),
      debug: (message, data) => log('DEBUG', `[${context}] ${message}`, data)
    };
  }
};

module.exports = logger;