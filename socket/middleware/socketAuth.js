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
  const apiKey = socket.handshake.auth.apiKey || socket.handshake.query.apiKey;
  const deviceId = socket.handshake.query.clientId;
  
  // Basic validation
  if (!apiKey) {
    return next(new Error('API key required'));
  }
  
  if (!deviceId) {
    return next(new Error('Device ID required'));
  }
  
  try {
    // Validate API key using deviceManager
    const isValidKey = await deviceManager.validateApiKey(apiKey);
    
    if (!isValidKey) {
      logger.warn(`Invalid API key used by device ${deviceId}`);
      return next(new Error('Invalid API key'));
    }
    
    // Attach device info to socket
    socket.deviceId = deviceId;
    
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
  const token = socket.handshake.auth.token;
  
  // Basic validation
  if (!token) {
    return next(new Error('JWT token required'));
  }
  
  try {
    // Verify JWT token
    const decoded = jwt.verify(token, config.jwtSecret);
    
    // Check if token exists in database
    const tokenResult = await socket.client.conn.db.query(
      "SELECT * FROM auth_tokens WHERE token = $1 AND expires_at > NOW()",
      [token]
    );
    
    if (tokenResult.rows.length === 0) {
      return next(new Error('Invalid or expired token'));
    }
    
    // Check if user exists and is active
    const userResult = await socket.client.conn.db.query(
      "SELECT * FROM users WHERE id = $1 AND is_active = true",
      [decoded.user.id]
    );
    
    if (userResult.rows.length === 0) {
      return next(new Error('User not found or inactive'));
    }
    
    // Get user permissions
    const permissionsResult = await socket.client.conn.db.query(
      "SELECT p.name FROM permissions p " +
      "JOIN role_permissions rp ON p.id = rp.permission_id " +
      "WHERE rp.role = $1",
      [decoded.user.role]
    );
    
    const permissions = permissionsResult.rows.map(row => row.name);
    
    // Check if user has required permissions
    if (!permissions.includes('view:dashboard')) {
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
      return next(new Error('Invalid or expired token'));
    }
    
    logger.error(`Dashboard authentication error: ${error.message}`);
    return next(new Error('Authentication failed'));
  }
}