/**
 * Socket.io Authentication Middleware
 * Validates connections based on client type
 */
const jwt = require('jsonwebtoken');
const deviceManager = require('../../api/services/deviceManager');
const logger = require('../../utils/logger');
const config = require('../../config/app');

/**
 * Socket authentication middleware
 * @param {Object} socket - Socket.io socket
 * @param {Function} next - Next function
 */
module.exports = async function(socket, next) {
  try {
    const clientType = socket.handshake.query.type;
    
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
    // Handle both header and query/auth API key sources
    // Windows app sends API key in different ways depending on connection type
    let apiKey = null;
    
    // Check auth object first
    if (socket.handshake.auth && socket.handshake.auth.apiKey) {
      apiKey = socket.handshake.auth.apiKey;
    }
    // Check query parameter next
    else if (socket.handshake.query && socket.handshake.query.apiKey) {
      apiKey = socket.handshake.query.apiKey;
    }
    // Finally check headers (from SignalingService.cs format)
    else if (socket.handshake.headers && socket.handshake.headers.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith('ApiKey ')) {
        apiKey = authHeader.substring(7); // Remove 'ApiKey ' prefix
      }
    }
    
    // Get device ID from clientId query parameter
    const deviceId = socket.handshake.query.clientId || socket.handshake.query.hostId;
    
    // Basic validation
    if (!apiKey) {
      logger.warn('Device connection attempt without API key');
      return next(new Error('API key required'));
    }
    
    if (!deviceId) {
      logger.warn('Device connection attempt without device ID');
      return next(new Error('Device ID required'));
    }
    
    // Validate API key against config
    const isValidKey = await deviceManager.validateApiKey(apiKey);
    
    if (!isValidKey) {
      logger.warn(`Invalid API key used by device ${deviceId}`);
      return next(new Error('Invalid API key'));
    }
    
    // Attach device info to socket
    socket.deviceId = deviceId;
    socket.deviceAuth = {
      apiKey: apiKey,
      authenticated: true,
      authenticatedAt: new Date()
    };
    
    logger.info(`Device authenticated: ${deviceId}`);
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
    
    if (socket.handshake.auth && socket.handshake.auth.token) {
      token = socket.handshake.auth.token;
    }
    else if (socket.handshake.headers && socket.handshake.headers.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7); // Remove 'Bearer ' prefix
      }
    }
    
    // Basic validation
    if (!token) {
      logger.warn('Dashboard connection attempt without JWT token');
      return next(new Error('JWT token required'));
    }
    
    // Verify JWT token
    const decoded = jwt.verify(token, config.jwtSecret);
    
    // Get database client
    const db = socket.client.conn.db;
    
    if (!db) {
      logger.error('Database connection not available');
      return next(new Error('Database error'));
    }
    
    // Check if token exists in database
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
    
    logger.info(`Dashboard user authenticated: ${decoded.user.username}`);
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