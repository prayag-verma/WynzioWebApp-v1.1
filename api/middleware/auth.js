const jwt = require("jsonwebtoken");

/**
 * Authentication middleware
 * Verifies JWT token and adds user to request
 */
module.exports = async function(req, res, next) {
  // Get token from header
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "No token provided, authorization denied"
    });
  }
  
  // Extract token
  const token = authHeader.split(" ")[1];
  
  try {
    // Verify token
    const decoded = jwt.verify(token, req.config.jwtSecret);
    
    // Get a client for transaction
    const client = await req.db.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');
      
      // Check if token exists in database
      const tokenResult = await client.query(
        "SELECT * FROM auth_tokens WHERE token = $1 AND expires_at > NOW()",
        [token]
      );
      
      if (tokenResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          message: "Token is not valid or has expired"
        });
      }
      
      // Check if user exists and is active
      const userResult = await client.query(
        "SELECT * FROM users WHERE id = $1 AND is_active = true",
        [decoded.user.id]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          message: "User not found or inactive"
        });
      }
      
      // Get user permissions
      const permissionsResult = await client.query(
        "SELECT p.name FROM permissions p " +
        "JOIN role_permissions rp ON p.id = rp.permission_id " +
        "WHERE rp.role = $1",
        [decoded.user.role]
      );
      
      const permissions = permissionsResult.rows.map(row => row.name);
      
      // Check if user has login permission
      if (!permissions.includes("login:allowed")) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          message: "You do not have permission to access this resource"
        });
      }
      
      await client.query('COMMIT');
      
      // Add user and permissions to request object
      req.user = {
        id: decoded.user.id,
        username: decoded.user.username,
        role: decoded.user.role,
        permissions: permissions
      };
      
      // Continue to next middleware
      next();
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error("Auth middleware error:", error);
    
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token has expired"
      });
    }
    
    res.status(401).json({
      success: false,
      message: "Token is not valid"
    });
  }
};