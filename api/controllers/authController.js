const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

/**
 * Handle user login
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.login = async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;
    
    // Input validation
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required"
      });
    }
    
    // Get a client from the pool for transaction
    const client = await req.db.connect();
    
    try {
      // Start transaction to ensure data consistency
      await client.query('BEGIN');
      
      // Get user from database
      const userResult = await client.query(
        "SELECT * FROM users WHERE username = $1 AND is_active = true",
        [username]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          message: "Invalid credentials"
        });
      }
      
      const user = userResult.rows[0];
      
      // Get user permissions
      const permissionsResult = await client.query(
        "SELECT p.name FROM permissions p " +
        "JOIN role_permissions rp ON p.id = rp.permission_id " +
        "WHERE rp.role = $1",
        [user.role]
      );
      
      const permissions = permissionsResult.rows.map(row => row.name);
      
      // Check if user has login permission
      if (!permissions.includes("login:allowed")) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          message: "You do not have permission to log in"
        });
      }
      
      // Check password using bcrypt's compare
      try {
        const isMatch = await bcrypt.compare(password, user.password_hash);
        
        if (!isMatch) {
          await client.query('ROLLBACK');
          return res.status(401).json({
            success: false,
            message: "Invalid credentials"
          });
        }
      } catch (bcryptError) {
        console.error("Password verification error:", bcryptError);
        await client.query('ROLLBACK');
        return res.status(500).json({
          success: false,
          message: "Error verifying credentials"
        });
      }
      
      // Create token payload
      const payload = {
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        }
      };
      
      // Token expiration
      const expiresIn = rememberMe ? "7d" : "1d";
      
      // Generate token
      const token = jwt.sign(
        payload,
        req.config.jwtSecret,
        { expiresIn }
      );
      
      // Update last login
      await client.query(
        "UPDATE users SET last_login = NOW() WHERE id = $1",
        [user.id]
      );
      
      // Store token in database
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + (rememberMe ? 7 : 1));
      
      await client.query(
        "INSERT INTO auth_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
        [user.id, token, expiresAt]
      );
      
      // Log successful login
      await logActivity(client, user.id, null, "user_login", {
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      
      // Commit transaction
      await client.query('COMMIT');
      
      // Send response with Cache-Control headers
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      
      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          permissions: permissions,
          lastLogin: user.last_login
        }
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during authentication"
    });
  }
};

/**
 * Validate authentication token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.validate = async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.json({ valid: false });
  }
  
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
        await client.query('COMMIT');
        
        // Set cache control headers
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Pragma', 'no-cache');
        
        return res.json({ valid: false });
      }
      
      // Check if user exists and is active
      const userResult = await client.query(
        "SELECT * FROM users WHERE id = $1 AND is_active = true",
        [decoded.user.id]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('COMMIT');
        
        // Set cache control headers
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Pragma', 'no-cache');
        
        return res.json({ valid: false });
      }
      
      await client.query('COMMIT');
      
      // Set cache control headers
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      
      res.json({ valid: true });
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (error) {
    // Set cache control headers
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
    
    res.json({ valid: false });
  }
};

/**
 * Logout user and invalidate token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.logout = async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(400).json({
      success: false,
      message: "No token provided"
    });
  }
  
  const token = authHeader.split(" ")[1];
  
  try {
    // Get a client for transaction
    const client = await req.db.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');
      
      // Invalidate token in database
      await client.query(
        "DELETE FROM auth_tokens WHERE token = $1",
        [token]
      );
      
      await client.query('COMMIT');
      
      // Set cache control headers
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      
      res.json({
        success: true,
        message: "Logged out successfully"
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during logout"
    });
  }
};

/**
 * Log activity to the database
 * @param {Object} db - Database client
 * @param {number} userId - User ID
 * @param {number} deviceId - Device ID (optional)
 * @param {string} action - Action performed
 * @param {Object} details - Additional details
 */
async function logActivity(db, userId, deviceId, action, details = {}) {
  try {
    await db.query(
      "INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)",
      [userId, action, JSON.stringify(details), details.ip || null]
    );
  } catch (error) {
    console.error("Error logging activity:", error);
  }
}