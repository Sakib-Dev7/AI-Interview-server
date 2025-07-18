import mongoose, { ClientSession, Types } from 'mongoose';
import { TProfile, TUser } from './user.interface';
import { ProfileModel, UserModel } from './user.model';
import { uploadImgToCloudinary } from '../../util/uploadImgToCludinary';
import authUtil from '../auth/auth.utill';
import { userRole } from '../../constents';
import path from 'path';
import { Resume } from '../resume/resume.model';
import { Payment } from '../payment/payment.model';
import { AssessmentModel } from '../vodeoAnalytics/video.model';
import { NotificationListModel } from '../notifications/notifications.model';
import { sendEmail } from '../../util/sendEmail';
import { generateEmailTemplate } from '../../util/emailTemplate';
import { sendSingleNotification } from '../firebaseSetup/sendPushNotification';

const createUser = async (payload: Partial<TUser>, method?: string) => {
  // Validate password match
  if (payload.password !== payload.confirmPassword) {
    return {
      success: false,
      message: 'Password and confirm password do not match.',
      data: { user: null, token: null },
    };
  }

  // Validate terms agreement
  if (!payload.aggriedToTerms) {
    return {
      success: false,
      message: 'You must agree to the terms and conditions to register.',
      data: { user: null, token: null },
    };
  }

  // Check for existing user
  const existingUser = await UserModel.findOne({ email: payload.email }).select(
    '+password',
  );

  if (existingUser && !existingUser.isDeleted) {
    return {
      success: false,
      message: 'A user with this email already exists and is active.',
      data: { user: null, token: null },
    };
  }

  // Create new payload with default role (avoid mutating input)
  const userPayload = {
    ...payload,
    role: payload.role || userRole.user,
  };

  // Remove confirmPassword from payload
  const { confirmPassword, ...userData } = userPayload;

  const session = await mongoose.startSession();

  try {
    // Manually start the transaction
    await session.startTransaction();

    let user;

    // Create user
    if (method) {
      const created = await UserModel.create([userData], { session });
      user = created[0];
    } else {
      user = new UserModel({ ...userData });
      await user.save({ session });
    }

    // Create profile
    const profileCration = await ProfileModel.create(
      [
        {
          name: userData.name ?? 'user',
          phone: userData.phone,
          email: userData.email!,
          user_id: user._id,
          // img: defaultImageUpload.secure_url,
        },
      ],
      { session },
    );

    await Resume.create(
      [
        {
          name: userData.name ?? 'user',
          phone: userData.phone,
          email: userData.email!,
          user_id: user._id,
        },
      ],
      { session },
    );

    await NotificationListModel.create(
      [
        {
          user_id: user._id, // This will be updated later
          Profile_id: profileCration[0]._id,
          oldNotificationCount: 0,
          seenNotificationCount: 0,
          newNotification: 0,
          notificationList: [],
        },
      ],
      { session },
    );

    // Commit the transaction
    await session.commitTransaction();

    // Fetch the user after transaction (excluding sensitive fields)
    const fetchedUser = await UserModel.findOne({
      email: userData.email,
    }).select('-password');
    if (!fetchedUser) {
      return {
        success: false,
        message: 'User created but not found after transaction.',
        data: { user: null, token: null },
      };
    }

    // --- Send Welcome Email here ---

    const notificationMessage = `
    Hi ${fetchedUser.name || 'User'},<br /><br />
    Thank you for registering with us! We're excited to have you on board.<br /><br />
    Feel free to explore the platform and improve your interview skills.<br /><br />
    Best wishes,<br />
    The AI Interview Team
  `;

    await sendEmail(
      fetchedUser.email,
      'Welcome to AI Interview Platform!',
      generateEmailTemplate({
        title: '🎉 Welcome to AI Interview Platform!',
        message: notificationMessage,
        ctaText: 'Get Started',
        ctaLink:
          'https://cerulean-pavlova-50e690.netlify.app/userDashboard/mockInterview',
      }),
    );

    await sendSingleNotification(
      fetchedUser._id,
      'Welcome to AI Interview',
      notificationMessage,
    );

    // Send OTP after transaction is complete
    const token = await authUtil.sendOTPviaEmail(fetchedUser);

    return {
      success: true,
      message: 'User created successfully and OTP sent.',
      user: fetchedUser.toObject(),
      token: token.token || null,
    };
  } catch (error: any) {
    // Rollback the transaction on error
    await session.abortTransaction();
    console.error('Error creating user:', error);
    return {
      success: false,
      message:
        error.message || 'User creation failed due to an internal error.',
      data: { user: null, token: null },
    };
  } finally {
    session.endSession();
  }
};

const setFCMToken = async (user_id: Types.ObjectId, fcmToken: string) => {
  if (!fcmToken) {
    throw new Error('fcm token is required');
  }

  const result = await UserModel.findOneAndUpdate(
    {
      _id: user_id,
    },
    {
      fcmToken: fcmToken,
    },
    { new: true },
  );

  return result;
};

const getAllUsers = async () => {
  const result = await UserModel.find({ isBlocked: false, isDeleted: false });
  return result;
};

const getAllAvailableUsers = async () => {
  const result = await UserModel.find({ isDeleted: false });
  return result;
};

const getAllProfiles = async () => {
  // Assuming you have a Profile model, fetch all profiles
  const profiles = await ProfileModel.find({});
  return profiles;
};

// update profile with profile image
const updateUserProfile = async (
  user_id: Types.ObjectId,
  payload: Partial<TProfile> = {},
  imgFile?: Express.Multer.File,
) => {
  const updatedProfileData = { ...payload };

  console.log('Image file received:', imgFile); // Debug log

  // If imgFile is provided, upload it to Cloudinary
  if (imgFile) {
    try {
      const imageUploadResult = await uploadImgToCloudinary(
        `profile-${user_id.toString()}`, // Custom name for the image
        imgFile.path, // Path to the uploaded image
      );

      // Add the image URL to the updated profile data
      updatedProfileData.img = imageUploadResult.secure_url;
    } catch (error: any) {
      throw new Error('Error uploading image: ' + error.message);
    }
  }

  // Check if there’s anything to update
  if (Object.keys(updatedProfileData).length === 0) {
    throw new Error('No data or image provided to update profile');
  }

  // Start a transaction to ensure atomic updates
  const session = await ProfileModel.startSession();
  session.startTransaction();

  try {
    // Update the Profile collection
    const updatedProfile = await ProfileModel.findOneAndUpdate(
      { user_id },
      { $set: updatedProfileData },
      { new: true, runValidators: true, session }, // Return updated doc, run validators, use session
    );

    if (!updatedProfile) {
      throw new Error('Profile not found for this user');
    }

    // If name or phone is provided in payload, update the User collection
    const userUpdateData: Partial<TUser> = {};
    if (updatedProfileData.name) {
      userUpdateData.name = updatedProfileData.name;
    }
    if (updatedProfileData.phone) {
      userUpdateData.phone = updatedProfileData.phone;
    }

    if (Object.keys(userUpdateData).length > 0) {
      const updatedUser = await UserModel.findByIdAndUpdate(
        user_id,
        { $set: userUpdateData },
        { new: true, runValidators: true, session }, // Return updated doc, run validators, use session
      );

      if (!updatedUser) {
        throw new Error('User not found');
      }
    }

    // Commit the transaction
    await session.commitTransaction();
    session.endSession();

    return updatedProfile;
  } catch (error: any) {
    // Abort the transaction on error
    await session.abortTransaction();
    session.endSession();
    throw new Error('Profile update failed: ' + error.message);
  }
};

const updateProfileData = async (
  user_id: Types.ObjectId,
  payload: Partial<TProfile>,
) => {
  try {
    const updatedProfile = await ProfileModel.findOneAndUpdate(
      { user_id },
      { $set: payload },
      { new: true },
    );
    return updatedProfile;
  } catch (error) {
    throw error;
  }
};

const deleteSingleUser = async (user_id: Types.ObjectId) => {
  const session: ClientSession = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate user_id
    if (!Types.ObjectId.isValid(user_id)) {
      throw new Error('Invalid user ID provided');
    }

    // Update the UserModel
    const updatedUser = await UserModel.findOneAndUpdate(
      { _id: user_id },
      { isDeleted: true, email: null },
      { new: true, session }, // Return the updated document
    );

    if (!updatedUser) {
      throw new Error('User not found');
    }

    // Update the ProfileModel
    const updatedProfile = await ProfileModel.findOneAndUpdate(
      { user_id },
      { isDeleted: true, email: null },
      { new: true, session }, // Return the updated document
    );

    if (!updatedProfile) {
      throw new Error('Profile not found for the user');
    }

    // Commit the transaction
    await session.commitTransaction();

    return {
      success: true,
      message: 'User and associated profile deleted successfully',
      data: {
        userId: user_id,
        updatedUser,
        updatedProfile,
      },
    };
  } catch (error: any) {
    // Abort the transaction on error
    await session.abortTransaction();
    throw new Error(`Failed to delete user: ${error.message}`);
  } finally {
    // Always end the session
    session.endSession();
  }
};

const selfDistuct = async (user_id: Types.ObjectId) => {
  const result = await deleteSingleUser(user_id);
  return result;
};

const uploadOrChangeImg = async (
  user_id: Types.ObjectId,
  imgFile: Express.Multer.File,
) => {
  if (!user_id || !imgFile) {
    throw new Error('User ID and image file are required.');
  }

  // Upload new image to Cloudinary
  const result = await uploadImgToCloudinary(imgFile.filename, imgFile.path);

  console.log(result);

  if (!result.secure_url) {
    throw new Error('Image upload failed.');
  }

  // Update user profile with new image URL
  const updatedUserProfile = await ProfileModel.findOneAndUpdate(
    { user_id }, // Corrected query (find by user_id, not _id)
    { img: result.secure_url },
    { new: true },
  );

  if (!updatedUserProfile) {
    throw new Error('Profile not found or update failed.');
  }

  return updatedUserProfile;
};

const getProfile = async (user_id: Types.ObjectId) => {
  const profile = await ProfileModel.findOne({ user_id }).populate([
    { path: 'user_id', model: 'UserCollection' },
    { path: 'notificationList_id', model: 'NotificationList' },
    { path: 'appliedJobs', model: 'Job' },
    { path: 'progress.interviewId', model: 'MockInterview' },
    {
      path: 'progress.questionBank_AndProgressTrack.questionBaank_id',
      model: 'QuestionBank',
    },
    {
      path: 'progress.questionBank_AndProgressTrack.lastQuestionAnswered_id',
      model: 'QuestionList',
    },
  ]);

  if (!profile) {
    throw new Error('Profile not found for the given user_id');
  }

  return profile;
};

// In userServices.ts
const updateUserByAdmin = async (
  userId: Types.ObjectId,
  payload: Partial<TUser>,
) => {
  console.log('Received userId:', userId.toString());
  console.log('Received payload:', payload);

  if (payload.isBlocked === true) {
    payload.isLoggedIn = false;
  }

  const updatedUser = await UserModel.findByIdAndUpdate(userId, payload, {
    new: true,
    runValidators: true,
  });

  if (!updatedUser) {
    throw new Error('User not found or update failed');
  }

  console.log('Updated user:', updatedUser);
  return updatedUser;
};

const getUserFullDetails = async (userId: Types.ObjectId) => {
  const user = await UserModel.findById(userId).select('-password');
  const profile = await ProfileModel.findOne({ user_id: userId });
  const resume = await Resume.findOne({ user_id: userId });
  const interviews = await AssessmentModel.findOne({ user_id: userId });

  return {
    user,
    profile,
    resume,
    interviews,
  };
};

const userServices = {
  createUser,
  getAllUsers,
  updateProfileData,
  deleteSingleUser,
  selfDistuct,
  uploadOrChangeImg,
  getProfile,
  updateUserProfile,
  getAllProfiles,
  updateUserByAdmin,
  getUserFullDetails,
  setFCMToken,
  getAllAvailableUsers,
};

export default userServices;
