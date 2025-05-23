const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const rbacMiddleware = require("../middleware/rbac");
const userController = require("../controllers/userController");

/**
 * @route GET /api/users/me
 * @desc Get current user's profile
 * @access Private
 */
router.get("/me", authMiddleware, userController.getCurrentUser);

/**
 * @route PUT /api/users/me/password
 * @desc Change current user's password
 * @access Private
 */
router.put("/me/password", authMiddleware, userController.changePassword);

module.exports = router;