const bcrypt = require('bcrypt');
const { pool } = require('../config/db');

/**
 * User model for operations on users table
 */
class User {
  /**
   * Find user by ID
   * @param {number} id - User ID
   * @returns {Promise<Object|null>} User object or null if not found
   */
  static async findById(id) {
    try {
      // Get a client from the pool
      const client = await pool.connect();
      
      try {
        // Start transaction
        await client.query('BEGIN');
        
        const result = await client.query(
          "SELECT * FROM users WHERE id = $1",
          [id]
        );
        
        await client.query('COMMIT');
        
        return result.rows.length > 0 ? result.rows[0] : null;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Error finding user by ID:", error);
      throw error;
    }
  }
  
  /**
   * Find user by username
   * @param {string} username - Username
   * @returns {Promise<Object|null>} User object or null if not found
   */
  static async findByUsername(username) {
    try {
      // Get a client from the pool
      const client = await pool.connect();
      
      try {
        // Start transaction
        await client.query('BEGIN');
        
        const result = await client.query(
          "SELECT * FROM users WHERE username = $1",
          [username]
        );
        
        await client.query('COMMIT');
        
        return result.rows.length > 0 ? result.rows[0] : null;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Error finding user by username:", error);
      throw error;
    }
  }
    
  /**
   * Get user permissions
   * @param {number} userId - User ID
   * @returns {Promise<Array>} Permissions
   */
  static async getPermissions(userId) {
    try {
      // Get a client from the pool
      const client = await pool.connect();
      
      try {
        // Start transaction
        await client.query('BEGIN');
        
        // First get user role
        const userResult = await client.query(
          "SELECT role FROM users WHERE id = $1",
          [userId]
        );
        
        if (userResult.rows.length === 0) {
          await client.query('COMMIT');
          return [];
        }
        
        const role = userResult.rows[0].role;
        
        // Get permissions for this role
        const permissionsResult = await client.query(
          "SELECT p.name FROM permissions p " +
          "JOIN role_permissions rp ON p.id = rp.permission_id " +
          "WHERE rp.role = $1",
          [role]
        );
        
        await client.query('COMMIT');
        
        return permissionsResult.rows.map(row => row.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Error getting user permissions:", error);
      throw error;
    }
  }
  
  /**
   * Check password
   * @param {string} plainPassword - Plain text password
   * @param {string} hashedPassword - Hashed password
   * @returns {Promise<boolean>} Match result
   */
  static async checkPassword(plainPassword, hashedPassword) {
    try {
      return await bcrypt.compare(plainPassword, hashedPassword);
    } catch (error) {
      console.error("Error checking password:", error);
      throw error;
    }
  }
}

module.exports = User;