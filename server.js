require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { connectionUserdb, connectionPaperdb } = require("./db");
const jwt = require("jsonwebtoken");
// const { error } = require('console');
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const { error } = require("console");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const { google } = require("googleapis");
const mysql = require('mysql2');
const bcrypt = require('bcrypt');


const app = express();
const SECRET_KEY = process.env.SECRET_KEYP;

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(cookieParser());

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const drive = google.drive({
  version: "v3",
  auth: oauth2Client,
});




// // Example function to query user data
async function getUserData() {
    try {
       console.log("Userdb Database is connected");
    } catch (err) {
        console.error('Error fetching user data:', err);
    }
}

// 
async function getPapersData() {
    try {
      console.log("Papersdb Database is connected");
    } catch (err) {
        console.error('Error fetching papers data:', err);
    }
}

getUserData();
getPapersData();





async function findFolder(folderName) {
  try {
    const response = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
    });

    const folders = response.data.files;
    if (folders.length > 0) {
      // Folder exists, return its ID
      return folders[0].id;
    } else {
      // Folder doesn't exist, return null
      return null;
    }
  } catch (error) {
    console.error("Error finding folder on Google Drive:", error);
    throw error;
  }
}

async function createDriveFolder(folderName) {
  try {
    const fileMetadata = {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      fields: "id",
    });

    // console.log('Folder created on Google Drive with ID:', response.data.id);
    return response.data.id; // Return the folder ID
  } catch (error) {
    console.error("Error creating folder on Google Drive:", error);
    throw error;
  }
}

// Function to Upload File to Google Drive
async function uploadFileToDrive(filename, folderId) {
  try {
    const filePath = path.join(__dirname, "uploads", filename); // File saved temporarily in uploads folder
    const fileMetadata = {
      name: filename, // Use the uploaded file's name
      parents: [folderId],
    };

    const media = {
      mimeType: "application/pdf", // Assuming the file is a PDF, adjust if needed
      body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id",
    });

    const fileId = response.data.id;

    drive.permissions.create({
      fileId: fileId,
      resource: {
        role: "reader",
        type: "anyone",
      },
    });

    // console.log('File uploaded successfully to Google Drive. File ID:', fileId);

    return response.data.id; // Return Google Drive file ID
  } catch (error) {
    console.error("Error uploading file to Google Drive:", error);
    throw error;
  }
}

// Multer Setup to Store Files Temporarily
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir); // Create uploads directory if it doesn't exist
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`); // Append timestamp to avoid overwriting
  },
});

const upload = multer({ storage });

// POST Route to Handle File Upload and Google Drive Integration
app.post("/api/Profile/upload", upload.single("file"), async (req, res) => {
  const { renameFileback, userid } = req.body;

  try {
    const file = req.file; // Get file info from multer
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Ensure folder exists or create it
    let folderId = await findFolder("User Uploads Files");
    if (!folderId) {
      folderId = await createDriveFolder("User Uploads Files"); // Create folder if it doesn't exist
    }

    // Upload the file to Google Drive
    const fileId = await uploadFileToDrive(file.filename, folderId);
    const filepath = `https://drive.google.com/file/d/${fileId}/view`;

    // Insert file details into database
    if (fileId) {
      const query = "INSERT INTO user_uploads (user_id, papername, paperlink) VALUES (?, ?, ?)";
      await new Promise((resolve, reject) => {
        connectionUserdb.query(query, [userid, renameFileback, filepath], (err) => {
          if (err) {
            console.error("Error inserting in database:", err);
            return reject("Error inserting data into database");
          }
          resolve();
        });
      });
    }

    // Delete the file from the local uploads directory after upload
    const tempFilePath = path.join(__dirname, "uploads", file.filename);
    await fs.promises.unlink(tempFilePath);

    // Clean up temporary folders
    const tmpDir = path.join(__dirname, "uploads/.tmp.driveupload");
    await fs.promises.rm(tmpDir, { recursive: true, force: true });

    // Send success response
    return res.status(200).json({
      message: "File uploaded successfully to Google Drive",
      fileId: fileId, // Returning Google Drive File ID
    });
  } catch (error) {
    console.error("Error uploading file:", error);
    return res.status(500).json({ error: "Failed to upload file" });
  }
});


app.get("/api/Profile/fetchpdf", async (req, res) => {
  try {
    const { userid } = req.body;
    const { papername, paperlink } = req.query;

    // Build the query dynamically
    let query = "SELECT * FROM user_uploads WHERE user_id = ?";
    const params = [userid];

    if (papername) {
      query += " AND papername = ?";
      params.push(papername);
    }

    if (paperlink) {
      query += " AND paperlink = ?";
      params.push(paperlink);
    }

    // Execute the query
    const [results] = await connectionUserdb.query(query, params);

    // Send the response
    res.status(200).json(results);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


app.post("/api/LogIn/Signup/otpVarify", async (req, res) => {
  const { email } = req.body;

  try {
    // Check if the email already exists in the verification table
    const checkQuery = "SELECT * FROM useremailverification WHERE gmail = ?";
    const [results] = await connectionUserdb.query(checkQuery, [email]);

    if (results.length === 0) {
      // If the email does not exist, insert it into the database
      const insertQuery = "INSERT INTO useremailverification (gmail) VALUES (?)";
      await connectionUserdb.query(insertQuery, [email]);
    }

    // Generate OTP and its expiry time
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpires = new Date(Date.now() + 10 * 60000); // OTP expires in 10 minutes

    // Update the OTP and expiry time in the database
    const updateQuery =
      "UPDATE useremailverification SET otp = ?, expireotp = ? WHERE gmail = ?";
    await connectionUserdb.query(updateQuery, [otp, otpExpires, email]);

    // Prepare and send OTP email
    const mailOptions = {
      to: email,
      from: process.env.EMAIL_USER,
      subject: "StudyVault OTP for verify Email",
      html: `
        <html>
          <body style="font-family: Arial, sans-serif; color: #333;">
            <div style="width: 80vw; margin: auto; border: 1px solid gray; border-radius: 4px; padding: 20px;">
              <h1 style="text-align: center;">Welcome to StudyVault</h1>
              <p style="text-align: center;font-size: 1.1rem">Hi...</p>
              <p>You requested to verify your email. Please use the following One-Time Password (OTP) to verify your email:</p>
              <h2 style="text-align: center; margin: auto; font-size: 2.4rem;">${otp}</h2>
              <p>The OTP is valid for the next 10 minutes. If you did not request to verify your email, please ignore this email.</p>
              <h4>Best regards,</h4>
              <h4>The StudyVault Team</h4>
            </div>
          </body>
        </html>
      `,
    };

    // Send OTP email
    await transporter.sendMail(mailOptions);

    // Send success response
    return res.status(200).json("OTP sent");
  } catch (error) {
    // Log the error and send a 500 response with error message
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


app.post("/api/LogIn/Signup/otpVarify/confirm", async (req, res) => {
  const { email, otp } = req.body;

  try {
    // Query to check the OTP for the given email
    const checkQuery = "SELECT * FROM useremailverification WHERE gmail = ? AND otp = ?";
    const [results] = await connectionUserdb.query(checkQuery, [email, otp]);

    if (results.length === 0) {
      // If no matching results, return an error
      return res.status(405).json({ error: "Invalid OTP or Invalid Email id" });
    }

    const otpExpires = results[0].expireotp;

    // Check if OTP is expired
    if (new Date(otpExpires) < new Date()) {
      return res.status(410).json({ error: "OTP expired" });
    }

    // Query to update the OTP and expiration fields
    const updateQuery = "UPDATE useremailverification SET otp = NULL, expireotp = NULL, gmail = NULL WHERE gmail = ?";
    await connectionUserdb.query(updateQuery, [email]);

    // Return success response
    return res.status(200).json({ message: "OTP verified and reset successfully" });

  } catch (err) {
    // Handle any unexpected errors
    console.error("Internal Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});




app.post("/api/LogIn/Signup", async (req, res) => {
  const { firstname, lastname, gmail, rollno, password, passwordcheck } = req.body;

  // Input validation
  if (!firstname || !lastname || !gmail || !rollno || !password || !passwordcheck) {
    return res.status(400).json({ error: "All fields are required" });
  }

  if (password !== passwordcheck) {
    return res.status(400).json({ error: "Passwords do not match" });
  }

  try {
    // Check if email already exists
    const checkQuery = "SELECT * FROM users WHERE gmail = ?";
    const [emailResults] = await connectionUserdb.query(checkQuery, [gmail]);

    if (emailResults.length > 0) {
      return res.status(409).json({ error: "Email already exists" });
    }

    // Check if roll number already exists
    const checkQueryRoll = "SELECT * FROM users WHERE rollno = ?";
    const [rollnoResults] = await connectionUserdb.query(checkQueryRoll, [rollno]);

    if (rollnoResults.length > 0) {
      return res.status(408).json({ error: "Roll number already exists" });
    }

    // Hash the password before storing it
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user into the database
    const query = "INSERT INTO users (firstname, lastname, gmail, rollno, password, passwordcheck) VALUES(?,?,?,?,?,?)";
    await connectionUserdb.query(query, [firstname, lastname, gmail, rollno, hashedPassword, passwordcheck]);

    return res.status(201).json({ message: "User registered successfully" });

  } catch (err) {
    console.error("Error during signup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


app.post("/api/LogIn", async (req, res) => {
  const { gmail, password } = req.body;

  const query = "SELECT * FROM users WHERE gmail = ? AND password = ?";

  try {
    // Use `await` with `connectionUserdb.query` as `createPool` supports promises
    const [results] = await connectionUserdb.query(query, [gmail, password]);

    if (results.length > 0) {
      const user = results[0];
      const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: "24h" });

      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // Set to true in production
        maxAge: 3600000, // 1 hour in milliseconds
      });

      res.status(200).json({ success: true, user });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  } catch (err) {
    console.error("Error retrieving data:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Middleware to authenticate the token
function authenticateToken(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.user = user;
    next();
  });
}

app.get("/api/signup-check", authenticateToken,async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";

  try {
    const [results] = await connectionUserdb.query(query, [req.user.id]);

    if (results.length > 0) {
      res.status(200).json({ message: "user is available" });
    } else {
      res.status(404).json({ error: "User not found" });
      return res.status({ error: "User not found" });
    }
}catch(err){
  console.error("Error retrieving user data", err);
  return res.status(500).json({ error: "Internal Server Error" });
}
  

});

app.get("/api/Profile", authenticateToken, async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";


  try {
    const [results] = await connectionUserdb.query(query, [req.user.id]);

    if (results.length > 0) {
      const user = results[0];
      res.status(200).json({ user });
    } else {
      res.status(404).json({ error: "User not found" });
    }
}catch(err){
  console.error("Error retrieving user data", err);
  return res.status(500).json({ error: "Internal Server Error" });
}
  

});

app.get("/api/Profile", authenticateToken, async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";


  try {
    const [results] = await connectionUserdb.query(query, [req.user.id]);

    if (results.length > 0) {
      const user = results[0];
      res.status(200).json({ user });
    }
    else {
      res.status(404).json({ error: "User not found" });
    }
}catch(err){
  console.error("Error retrieving user data", err);
  return res.status(500).json({ error: "Internal Server Error" });
}
});

app.get("/api", authenticateToken,async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";

  try{
    const [results] = await  connectionUserdb.query(query, [req.user.id]);

    if (results.length > 0) {
      const user = results[0];
      // console.log(user);
      return res.status(200).json({ success: true });
    } else {
      return res.status(404).json({ message: "User not found" });
    }
  }catch(err){
    console.error("Error retrieving user data", err);
      return res.status(500).json({ error: "Internal Server Error" });
  }

});

app.post("/api/logOut", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,    // Makes the cookie inaccessible to JavaScript (prevents XSS attacks)
    secure: process.env.NODE_ENV === "production", // Ensures the cookie is only sent over HTTPS in production
    sameSite: "Strict", // Limits the cookie to be sent in first-party contexts
    path: "/",         // Ensures the cookie is cleared for the entire app
  });

  res.status(200).json({ success: true });
});


// Paper PDF BACKEND

app.get("/api/login-check-filter", authenticateToken, async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";

  try {
    // Execute query using async/await with promise-based API
    const [results] = await connectionUserdb.query(query, [req.user.id]);

    // Check if user exists and respond accordingly
    if (results.length > 0) {
      return res.status(200).json({ message: "Successful" });
    }

    // If no user is found, send a 404 response
    return res.status(404).json({ error: "User not found" });

  } catch (err) {
    console.error("Error retrieving user data:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});



app.get("/api/login-check-context", authenticateToken, async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";

  try {
    const [results] = await connectionUserdb.query(query, [req.user.id]);

    if (results.length > 0) {
      return res.status(200).json({ message: "Successful" });
    } else {
      return res.status(404).json({ error: "User not found" });
    }
  } catch (err) {
    console.error("Error retrieving user data:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


app.get("/api/Filter", async (req, res) => {
  let query = "SELECT * FROM papers WHERE 1=1";
  const params = [];

  try {
    // Add departmentName filter if provided
    if (req.query.departmentName) {
      query += " AND departmentName = ?";
      params.push(req.query.departmentName);
    }

    // Add educationLevel filter for UG and PG
    if (req.query.educationLevelug === "ug" || req.query.educationLevelpg === "pg") {
      let educationLevels = [];
      if (req.query.educationLevelug === "ug") {
        educationLevels.push("ug");
      }
      if (req.query.educationLevelpg === "pg") {
        educationLevels.push("pg");
      }

      if (educationLevels.length > 0) {
        query += " AND educationLevel IN (?)"; // Use ? to prevent SQL injection
        params.push(educationLevels);
      }
    }

    // Add fromDate filter if provided
    if (req.query.fromDate) {
      query += " AND years >= ?";
      params.push(req.query.fromDate);
    }

    // Add toDate filter if provided
    if (req.query.toDate) {
      query += " AND years < ?";
      params.push(req.query.toDate);
    }

    // Add departmentYear filter if provided
    if (req.query.departmentYear) {
      query += " AND departmentYear = ?";
      params.push(req.query.departmentYear);
    }

    // Add semester or midSem filter if provided
    if (req.query.sem === "true" || req.query.midSem === "true") {
      let conditions = [];
      if (req.query.sem === "true") {
        conditions.push("sem = true");
      }
      if (req.query.midSem === "true") {
        conditions.push("midSem = true");
      }

      if (conditions.length > 0) {
        query += " AND (" + conditions.join(" OR ") + ")";
      }
    }

    // If no valid filters are provided, return an error
    if (params.length === 0 && !req.query.sem && !req.query.midSem) {
      return res.status(400).json({ error: "No filter parameters provided" });
    }

    // Execute the query with parameters
    const [results] = await connectionPaperdb.query(query, params);

    // Return the filtered results
    res.status(200).json(results);
  } catch (err) {
    console.error("Error fetching papers:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// Forgate page

app.post("/api/LogIn/ForgatePw", async (req, res) => {
  const { email } = req.body;

  try {
    // Check if the email exists in the database
    const [results] = await connectionUserdb.query("SELECT * FROM users WHERE gmail = ?", [email]);
    if (results.length === 0) {
      return res.status(409).json({ error: "Email not found" });
    }

    const user = results[0];
    const now = new Date();
    const lastOtpTime = new Date(user.lastOtpTime);

    // Prevent sending OTP if the last OTP request was made within 30 seconds
    if (user.lastOtpTime && now - lastOtpTime < 30000) {
      return res.status(429).json({
        error: "OTP already sent. Please wait 30 seconds before requesting another OTP",
      });
    }

    // Generate OTP and expiration time
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpires = new Date(Date.now() + 10 * 60000); // OTP valid for 10 minutes

    // Update OTP, expiration time, and last OTP sent time in the database
    await connectionUserdb.query(
      "UPDATE users SET otp = ?, otpExpires = ?, lastOtpTime = ? WHERE gmail = ?",
      [otp, otpExpires, now, email]
    );

    // Send OTP email
    const mailOptions = {
      to: email,
      from: process.env.EMAIL_USER,
      subject: "StudyVault Password Reset OTP",
      html: `
        <html>
          <body style="font-family: Arial, sans-serif; color: #333;">
            <div style="width: 80vw; margin: auto; border: 1px solid gray; border-radius: 4px; padding: 20px;">
              <h1 style="text-align: center;">Welcome to StudyVault</h1>
              <p style="text-align: center; font-size: 1.1rem">Hi, ${user.firstname} ${user.lastname}</p>
              <p>You requested to reset your password. Please use the following One-Time Password (OTP) to reset your password:</p>
              <h2 style="text-align: center; margin: auto; font-size: 2.4rem;">${otp}</h2>
              <p>The OTP is valid for the next 10 minutes. If you did not request a password reset, please ignore this email.</p>
              <h4>Best regards,</h4>
              <h4>The StudyVault Team</h4>
            </div>
          </body>
        </html>
      `,
    };

    // Send the email
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error("Email sending error:", err);
        return res.status(500).json({ error: "Email sending error" });
      }
      console.log("Email sent:", info.response);
      return res.status(200).json("OTP sent");
    });
  } catch (err) {
    console.error("Error handling request:", err);
    return res.status(500).json({ error: "Database or server error" });
  }
});


app.post("/api/LogIn/verifyOtp", async (req, res) => {
  const { otp, email } = req.body;

  try {
    // Check if the user exists and the OTP is correct
    const [results] = await connectionUserdb.query(
      "SELECT * FROM users WHERE gmail = ? AND otp = ?",
      [email, otp]
    );

    if (results.length === 0) {
      console.error("Incorrect OTP");
      return res.status(409).json({ error: "Incorrect OTP" });
    }

    const otpExpires = results[0].otpExpires;
    if (new Date(otpExpires) < new Date()) {
      return res.status(410).json({ error: "OTP expired" });
    }

    // Update the OTP and expiration time to null after verification
    const [updateResults] = await connectionUserdb.query(
      "UPDATE users SET otp = NULL, otpExpires = NULL, lastOtpTime = NULL WHERE gmail = ?",
      [email]
    );

    if (updateResults.affectedRows === 0) {
      console.error("Error updating OTP status in database");
      return res.status(500).json({ error: "Error updating database" });
    }

    // Respond with a success message
    return res.status(200).json({ message: "OTP verified and reset successfully" });
  } catch (err) {
    console.error("Error verifying OTP:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});


app.post("/api/LogIn/ForgatePw/ResetPassword",async (req, res) => {
  const { email, resetPassword } = req.body;
  const query =
    "UPDATE users SET password = ?, passwordcheck = ? WHERE gmail = ?";

    try{
      const [result] = await connectionUserdb.query(
        query,
        [resetPassword, resetPassword, email]);

        return res.status(200).json({ message: "Update password successfully" });

    }catch(err){
      console.error("Error inserting in database", err);
      return res.status(500).json({ error: "Error inserting in database" });
    }
});

app.get("/api/feedback-check", authenticateToken, async (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";


  try{
    const [results] = await connectionUserdb.query(query, [req.user.id]);
    if (results.length > 0) {
      const user = results[0];
      res.status(200).json(user);

    }
    return res.status(404).json({ error: "User not found" });

  }catch(err){
    console.error("Error retrieving user data", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
 
});

app.post("/api/feedback-submission", async (req, res) => {
  const { star, feedbackmessage, gmail } = req.body;

  try {
    // Check if the user exists in the database
    const [user] = await connectionUserdb.query("SELECT * FROM users WHERE gmail = ?", [gmail]);

    if (user.length === 0) {
      console.error("User not found");
      return res.status(404).json({ err: "User not logged in" });
    }

    // Update the user's rating and feedback
    const [result] = await connectionUserdb.query(
      "UPDATE users SET ratestar = ?, feedbackmessage = ? WHERE gmail = ?",
      [star, feedbackmessage, gmail]
    );

    if (result.affectedRows === 0) {
      console.error("Database error while updating feedback");
      return res.status(500).json({ err: "Database error while updating feedback" });
    }

    // Send success response
    res.status(200).json({ message: "Feedback submitted successfully", result });
  } catch (error) {
    console.error("Internal error", error);
    res.status(500).json({ err: "Internal error" });
  }
});


//Admin

//File Upload



async function findFolder(folderName, parentFolderId = "root") { 
  try {
    const response = await drive.files.list({
      q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentFolderId}' in parents`,
      fields: "files(id, name)",
    });

    const folder = response.data.files[0];
    if (!folder) {
      console.log(`Folder "${folderName}" not found in parent "${parentFolderId}".`);
      return null;
    }

    console.log(`Folder "${folderName}" found with ID: ${folder.id}`);
    return folder.id; // Return the folder ID
  } catch (error) {
    console.error("Error finding folder on Google Drive:", error);
    throw error;
  }
}

async function findNestedFolder(folderPath) {
  const folderNames = folderPath.split("/"); // Split the folder path into parts
  let currentParentId = "root"; // Start from the root directory

  for (const folderName of folderNames) {
    const folderId = await findFolder(folderName, currentParentId);
    if (!folderId) {
      console.log(`Folder "${folderName}" does not exist.`);

      // If folder doesn't exist, attempt to clean up the "uploads" folder
      await deleteTempFiles();
      return null; // Stop if any folder in the path is not found
    }
    currentParentId = folderId; // Move into the found folder
  }

  return currentParentId; // Return the ID of the final folder in the path
}

// Function to clean up the temporary files in the uploads directory
async function deleteTempFiles() {
  const uploadFolderPath = path.join(__dirname, "uploads");

  try {
    const files = await fs.promises.readdir(uploadFolderPath);

    for (const file of files) {
      const filePath = path.join(uploadFolderPath, file);
      await fs.promises.unlink(filePath); // Delete the file
      console.log("Deleted file:", filePath);
    }
  } catch (error) {
    console.error("Error deleting files in uploads folder:", error);
  }
}



app.post("/api/Admin/upload", upload.single("file"), async (req, res) => {
  const { renameFileback, filtetuploaddata } = req.body;
  const parsedData = JSON.parse(filtetuploaddata);

  const {
    departmentName,
    educationLavel,
    session,
    dptyear,
    semormid,
    studentyear,
  } = parsedData;

  try {
    const file = req.file;
    if (!file) {
      return res.status(400).send("No file uploaded");
    }

    let sem = 0;
    let midsem = 0;

    if (semormid === "sem") {
      sem = 1;
    } else if (semormid === "midSem") {
      midsem = 1;
    }

    // Determine the folder path based on department and other attributes
    let folderPath;
    if (["Elective", "Compulsory", "E&V"].includes(departmentName)) {
      folderPath = `MPC Papers Pdf/${departmentName}`;
    } else {
      folderPath = `MPC Papers Pdf/${educationLavel}/${semormid}/${studentyear}/${dptyear}/${departmentName}`;
    }

    // Check if folder exists on Google Drive
    const folderId = await findNestedFolder(folderPath);

    if (!folderId) {
      return res.status(401).json({ message: `Folder "${folderPath}" does not exist.` });
    }

    // Upload the file to Google Drive
    const fileId = await uploadFileToDrive(file.filename, folderId);
    if (!fileId) {
      return res.status(300).send("Failed to upload file to Google Drive");
    }

    // Check if a file with the same title already exists in the database
    const checkQuery = "SELECT * FROM papers WHERE title = ?";
    const [checkResults] = await connectionPaperdb.query(checkQuery, [renameFileback]);

    if (checkResults.length > 0) {
      return res.status(400).json({
        message: `A file with the title "${renameFileback}" already exists in the database.`,
      });
    }

    // Construct the file URL
    const filepath = `https://drive.google.com/file/d/${fileId}/view`;

    // Insert the file details into the database
    const insertQuery =
      "INSERT INTO papers (departmentName, educationLevel, years, departmentYear, sem, midSem, title, url, semester) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

    await connectionPaperdb.query(insertQuery, [
      departmentName,
      educationLavel,
      session,
      studentyear,
      sem,
      midsem,
      renameFileback,
      filepath,
      dptyear,
    ]);

    // Clean up the temporary file
    const tempFilePath = path.join(__dirname, "uploads", file.filename);
    fs.unlink(tempFilePath, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    const tmpDir = path.join(__dirname, "uploads/.tmp.driveupload");
    fs.rm(tmpDir, { recursive: true, force: true }, (err) => {
      if (err) console.error("Error deleting temp folder:", err);
    });

    // Send success response
    res.status(200).send({
      message: "File uploaded successfully to Google Drive",
      fileId: fileId,
    });
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).send("An error occurred while processing the request");
  }
});


app.get("/api/admin/fetchData", async (req, res) => {
  let query = "SELECT * FROM papers ";
  try{
    const [results] = await connectionPaperdb.query(query); 
    
    res.status(200).json(results);

  }catch(err){
    console.error("Error fetching papers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

//Admin LogIN

app.post("/api/Admin/AdminLogIn", async (req, res) => {
    const { userid, password } = req.body;
  
    const query = "SELECT * FROM admin_login WHERE userid = ? AND password = ? ";
  
    try{
      const [results] = await connectionPaperdb.query(query, [userid, password]);
  
      if (results.length === 0) {
        return res.status(400).json({ error: "Invalid Credentials" });
  
        
      }
      const token = jwt.sign({ userId: results[0].userid }, SECRET_KEY, {
        expiresIn: "12h", // Token expiration time
      });
  
      return res.status(200).json({ message: "Seccessfully LogIn", token });
  
    }catch(err){
      return res.status(500).json({ error: "Internal server error" });
    } 
  
    });


app.get("/api/adminPage", async (req, res) => {
  try {
    // Get token from the Authorization header
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Verify the token asynchronously
    const decoded = await jwt.verify(token, SECRET_KEY);

    // Token is valid, proceed with the request
    res.status(200).json({ message: "Admin page content", userId: decoded.userId });
  } catch (err) {
    console.error("Error during token verification:", err);
    res.status(401).json({ error: "Invalid or expired token" });
  }
});


/////////////

const port = process.env.PORT || 3000;
const ip = process.env.IP || "127.0.0.1";

app.listen(port, ip, () => {
  console.log(`The website is running on port ${port}`);
});
