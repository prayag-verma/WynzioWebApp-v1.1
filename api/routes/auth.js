const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

/**
 * @route POST /api/auth/login
 * @desc Authenticate user and get token
 * @access Public
 */
router.post("/login", authController.login);

/**
 * @route GET /api/auth/validate
 * @desc Validate authentication token
 * @access Public
 */
router.get("/validate", authController.validate);

/**
 * @route POST /api/auth/logout
 * @desc Logout user and invalidate token
 * @access Private
 */
router.post("/logout", authController.logout);

module.exports = router;