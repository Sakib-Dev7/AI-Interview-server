import express from "express";
import notificationController from "./notifications.controller";
import auth from "../../middlewares/auth";
import { userRole } from "../../constents";

const notificationRouter = express.Router()

notificationRouter.get("/getAllNotifications",auth([userRole.admin, userRole.user]),notificationController.getAllNotifications )
notificationRouter.get("/viewSpecificNotification",auth([userRole.admin, userRole.user]),notificationController.viewSpecificNotification )
notificationRouter.post("/sendNotificationFromAdmin",auth([userRole.admin]),notificationController.sendNotificationFromAdmin )
notificationRouter.get("/getAllNotificationForAdmin",auth([userRole.admin]),notificationController.getAllNotificationForAdmin )


export default notificationRouter