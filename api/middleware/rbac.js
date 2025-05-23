/**
 * Role-Based Access Control (RBAC) middleware
 * Checks if user has required roles or permissions
 * 
 * @param {Array|String} roles - Required roles
 * @param {Array|String} permissions - Required permissions
 * @returns {Function} Middleware function
 */
module.exports = function(roles = [], permissions = []) {
  // Convert string parameters to arrays if needed
  if (typeof roles === 'string') {
    roles = [roles];
  }
  
  if (typeof permissions === 'string') {
    permissions = [permissions];
  }
  
  return function(req, res, next) {
    // Check if user object exists (auth middleware should have added it)
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Authentication required"
      });
    }
    
    // If no roles or permissions are required, continue
    if (roles.length === 0 && permissions.length === 0) {
      return next();
    }
    
    // Check if user has any of the required roles
    const hasRole = roles.length === 0 || roles.includes(req.user.role);
    
    // Check if user has all of the required permissions
    const hasPermissions = permissions.length === 0 || 
      permissions.every(permission => req.user.permissions.includes(permission));
    
    // If user has required role or permissions, continue
    if (hasRole || hasPermissions) {
      return next();
    }
    
    // Otherwise, deny access
    res.status(403).json({
      success: false,
      message: "Access denied: Insufficient permissions"
    });
  };
};