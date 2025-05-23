/**
 * Socket.io Authentication Middleware
 * Validates connections based on client type
 */
const jwt = require('jsonwebtoken');
const deviceManager = require('../../api/services/deviceManager');
const logger = require('../../utils/logger');
const config = require('../../config/app');
const signalingService = require('../signalingService');

/**
 * Socket authentication middleware
 * @param {Object} socket - Socket.io socket
 * @param {Function} next - Next function
 */
module.exports = async function(socket, next) {
  try {
    // Check for both query and handshake parameters to support Windows app format
    const clientType = socket.handshake.query.type || 
                      (socket.handshake.query.remotePcId ? 'device' : 
                      (socket.handshake.query.clientId && socket.handshake.query.clientId.startsWith('web-client') ? 'dashboard' : null));
    
    // Validate client type
    if (!clientType) {
      return next(new Error('Client type not specified'));
    }
    
    // Different auth methods based on client type
    if (clientType === 'device') {
      await authenticateDevice(socket, next);
    } else if (clientType === 'dashboard') {
      await authenticateDashboard(socket, next);
    } else {
      return next(new Error('Invalid client type'));
    }
  } catch (error) {
    logger.error('Socket authentication error:', error);
    return next(new Error('Authentication failed'));
  }
};

/**
 * Authenticate device client (Windows app)
 * @param {Object} socket - Socket.io socket
 * @param {Function} next - Next function
 */
async function authenticateDevice(socket, next) {
  try {
    // Handle both header and query/auth API key sources to accommodate Windows app
    let apiKey = null;
    
    // Check authorization header first (primary method used by Windows app)
    if (socket.handshake.headers && socket.handshake.headers.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith('ApiKey ')) {
        apiKey = authHeader.substring(7); // Remove 'ApiKey ' prefix
      } else {
        apiKey = authHeader; // Try raw value
      }
    }
    // Check auth object next
    else if (socket.handshake.auth && socket.handshake.auth.apiKey) {
      apiKey = socket.handshake.auth.apiKey;
    }
    // Check query parameter next
    else if (socket.handshake.query && socket.handshake.query.apiKey) {
      apiKey = socket.handshake.query.apiKey;
    }
    // Check direct 'auto-register' message for compatibility with Windows app (ConnectionSettings.cs)
    else if (socket.handshake.query.remotePcId) {
      // For the initial connection, use default API key from configuration
      // This will be validated properly during the 'auto-register' event
      apiKey = config.remoteApiKey; // Updated from deviceApiKey to remoteApiKey
      logger.info(`Using default API key for initial device connection: ${socket.handshake.query.remotePcId}`);
    }
    
    // Get remotePcId from multiple possible sources - Windows app uses remotePcId
    const remotePcId = socket.handshake.query.remotePcId;
    
    // Basic validation
    if (!apiKey) {
      // For development/testing only - auto-pass with correct device API key
      if (process.env.NODE_ENV === 'development' && remotePcId) {
        apiKey = config.remoteApiKey; // Updated from deviceApiKey to remoteApiKey
        logger.warn(`DEV MODE: Auto-assigning API key for device ${remotePcId}`);
      } else {
        logger.warn('Device connection attempt without API key');
        return next(new Error('API key required'));
      }
    }
    
    if (!remotePcId) {
      logger.warn('Device connection attempt without remotePcId');
      return next(new Error('remotePcId required'));
    }
    
    // Check for session reuse if sid provided - added for Windows app compatibility
    const sid = socket.handshake.auth.sid;
    if (sid) {
      if (signalingService.isSessionValid(sid)) {
        logger.info(`Reusing valid session for device ${remotePcId}`);
        // Extend session
        signalingService.extendSession(sid);
        // Also store connection mapping for better reconnection
        signalingService.storeConnection(remotePcId, sid);
        // Update active connections map if the device reconnects
        if (signalingService.activeConnections) {
          signalingService.activeConnections.set(remotePcId, socket);
        }
      } else {
        // Don't reject immediately, let Windows app fall back to new handshake
        logger.info(`Invalid or expired session for device ${remotePcId}, will use new handshake`);
      }
    }
    
    // Validate API key against config and handle multiple formats
    let isValidKey = false;
    
    // Normalize API keys for comparison to match Windows app exactly
    const expectedKey = config.remoteApiKey.replace('ApiKey ', '');
    const providedKey = apiKey.replace('ApiKey ', '');
    
    // Direct string comparison
    if (providedKey === expectedKey) {
        isValidKey = true;
    } else {
        // Fall back to database validation
        isValidKey = await deviceManager.validateApiKey(apiKey);
    }
    
    if (!isValidKey) {
      logger.warn(`Invalid API key used by device ${remotePcId}`);
      return next(new Error('Invalid API key'));
    }
    
    // Attach device info to socket
    socket.remotePcId = remotePcId;
    socket.deviceAuth = {
      apiKey: providedKey, // Use normalized key
      authenticated: true,
      authenticatedAt: new Date()
    };
    
    logger.info(`Device authenticated: ${remotePcId}`);
    return next();
  } catch (error) {
    logger.error(`Device authentication error: ${error.message}`);
    return next(new Error('Device authentication failed'));
  }
}

/**
 * Authenticate dashboard client (web browser)
 * @param {Object} socket - Socket.io socket
 * @param {Function} next - Next function
 */
async function authenticateDashboard(socket, next) {
  try {
    // Get token from auth object or headers
    let token = null;
    
    // Check authorization header first
    if (socket.handshake.headers && socket.handshake.headers.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7); // Remove 'Bearer ' prefix
      } else {
        token = authHeader; // Try raw value
      }
    }
    // Check auth object next
    else if (socket.handshake.auth && socket.handshake.auth.token) {
      token = socket.handshake.auth.token;
    }
    
    // Check for session reuse if sid provided
    const sid = socket.handshake.auth.sid;
    if (sid && signalingService.isSessionValid(sid)) {
      logger.info(`Reusing valid session for dashboard client ${socket.id}`);
      // Extend session
      signalingService.extendSession(sid);
    }
    
    // Basic validation
    if (!token) {
      // For development/testing - allow bypass
      if (process.env.NODE_ENV === 'development') {
        logger.warn('DEV MODE: Bypassing dashboard auth');
        socket.user = {
          id: 'dev-user',
          username: 'developer',
          role: 'admin',
          permissions: ['view:dashboard', 'control:devices', 'view:devices']
        };
        return next();
      }
      
      logger.warn('Dashboard connection attempt without JWT token');
      return next(new Error('JWT token required'));
    }
    
    // Verify JWT token
    const decoded = jwt.verify(token, config.jwtSecret);
    
    // Get database client
    const db = global.db || socket.client.conn.db;
    
    if (!db) {
      // For development/testing - allow bypass if no DB
      if (process.env.NODE_ENV === 'development') {
        logger.warn('DEV MODE: No DB connection, allowing dashboard auth');
        socket.user = {
          id: decoded.user?.id || 'dev-user',
          username: decoded.user?.username || 'developer',
          role: decoded.user?.role || 'admin',
          permissions: ['view:dashboard', 'control:devices', 'view:devices']
        };
        return next();
      }
      
      logger.error('Database connection not available');
      return next(new Error('Database error'));
    }
    
    // Check if token exists in database
    try {
      const tokenResult = await db.query(
        "SELECT * FROM auth_tokens WHERE token = $1 AND expires_at > NOW()",
        [token]
      );
      
      if (tokenResult.rows.length === 0) {
        logger.warn('Invalid or expired token used for dashboard connection');
        return next(new Error('Invalid or expired token'));
      }
      
      // Check if user exists and is active
      const userResult = await db.query(
        "SELECT * FROM users WHERE id = $1 AND is_active = true",
        [decoded.user.id]
      );
      
      if (userResult.rows.length === 0) {
        logger.warn(`User not found or inactive: ${decoded.user.id}`);
        return next(new Error('User not found or inactive'));
      }
      
      // Get user permissions
      const permissionsResult = await db.query(
        "SELECT p.name FROM permissions p " +
        "JOIN role_permissions rp ON p.id = rp.permission_id " +
        "WHERE rp.role = $1",
        [decoded.user.role]
      );
      
      const permissions = permissionsResult.rows.map(row => row.name);
      
      // Check if user has required permissions
      if (!permissions.includes('view:dashboard')) {
        logger.warn(`User ${decoded.user.username} lacks view:dashboard permission`);
        return next(new Error('Insufficient permissions'));
      }
      
      // Attach user info to socket
      socket.user = {
        id: decoded.user.id,
        username: decoded.user.username,
        role: decoded.user.role,
        permissions
      };
    } catch (dbError) {
      // If database query fails, use decoded token info as fallback
      // This is for development and testing purposes
      logger.warn('Database query failed, falling back to decoded token');
      
      if (process.env.NODE_ENV === 'development') {
        socket.user = {
          id: decoded.user?.id || 'unknown',
          username: decoded.user?.username || 'unknown',
          role: decoded.user?.role || 'user',
          permissions: ['view:dashboard', 'control:devices', 'view:devices']
        };
      } else {
        throw dbError; // Re-throw in production
      }
    }
    
    logger.info(`Dashboard user authenticated: ${socket.user.username || 'unknown'}`);
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      logger.warn('JWT validation error: ' + error.message);
      return next(new Error('Invalid or expired token'));
    }
    
    logger.error(`Dashboard authentication error: ${error.message}`);
    return next(new Error('Authentication failed'));
  }
}