const User = require('../../models/user');

/**
 * Get current user's profile
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getCurrentUser = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get a client from the pool for transaction
    const client = await req.db.connect();
    
    try {
      // Start transaction to ensure data consistency
      await client.query('BEGIN');
      
      // Get user from database with fresh data
      const userResult = await client.query(
        "SELECT * FROM users WHERE id = $1 AND is_active = true",
        [userId]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: "User not found"
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
      
      await client.query('COMMIT');
      
      // Format user data
      const formattedUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        lastLogin: user.last_login,
        createdAt: user.created_at,
        permissions: permissions
      };
      
      // Set cache control headers
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      
      res.json({
        success: true,
        data: formattedUser
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching user profile"
    });
  }
};

/**
 * Change current user's password
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    // Validate required fields
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required"
      });
    }
    
    // Get a client for transaction
    const client = await req.db.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');
      
      // Get user with password hash
      const userResult = await client.query(
        "SELECT * FROM users WHERE id = $1",
        [req.user.id]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: "User not found"
        });
      }
      
      const user = userResult.rows[0];
      
      // Verify current password
      const bcrypt = require('bcrypt');
      const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
      
      if (!isMatch) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: "Current password is incorrect"
        });
      }
      
      // Update password in database
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(newPassword, salt);
      
      await client.query(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        [passwordHash, req.user.id]
      );
      
      // Log password change
      await client.query(
        "INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)",
        [req.user.id, "password_changed", JSON.stringify({
          userId: req.user.id,
          ipAddress: req.ip
        }), req.ip]
      );
      
      await client.query('COMMIT');
      
      // Set cache control headers
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      
      res.json({
        success: true,
        message: "Password changed successfully"
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error("Error changing password:", error);
    res.status(500).json({
      success: false,
      message: "Server error while changing password"
    });
  }
};

module.exports = exports;