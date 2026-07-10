import nodemailer from 'nodemailer';
import Notification from '../models/Notification';
import Lead from '../models/Lead';
import Tenant from '../models/Tenant';
import { getIO } from './socket/socketService';

// SMTP Configuration
const smtpPort = Number(process.env.SMTP_PORT) || 2525;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
  port: smtpPort,
  secure: smtpPort === 465, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER || 'mock_smtp_user',
    pass: process.env.SMTP_PASS || 'mock_smtp_pass',
  },
  tls: {
    rejectUnauthorized: false
  }
});

export const sendEmail = async (leadId: string | null, to: string, subject: string, text: string): Promise<boolean> => {
  try {
    console.log(`[Email Dispatch] To: ${to}, Subject: "${subject}", Body: "${text.substring(0, 50)}..."`);

    // Fetch tenantId
    let tenantId;
    if (leadId) {
      const lead = await Lead.findById(leadId);
      tenantId = lead?.tenantId;
    }
    if (!tenantId) {
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id;
      }
    }

    // Log to DB
    const notification = new Notification({
      tenantId,
      leadId,
      channel: 'Email',
      message: `Subject: ${subject} | ${text}`,
      status: 'Sent',
      sentAt: new Date(),
    });
    await notification.save();

    // Trigger Socket update
    const io = getIO();
    if (io) {
      io.to('/crm').emit('notification:sent', {
        leadId,
        channel: 'Email',
        message: `Email Sent to ${to}: ${subject}`,
        timestamp: new Date(),
      });
    }

    // Try real send (fallback if user details are mock)
    if (process.env.SMTP_USER && !process.env.SMTP_USER.startsWith('mock')) {
      await transporter.sendMail({
        from: `"AuraHome CRM" <${process.env.SMTP_USER}>`,
        to,
        subject,
        text,
      });
    }

    return true;
  } catch (error: any) {
    console.error('Error sending email:', error.message);
    return false;
  }
};

export const sendSMS = async (leadId: string | null, to: string, text: string): Promise<boolean> => {
  try {
    console.log(`[SMS Dispatch] To: ${to}, Body: "${text}"`);

    // Fetch tenantId
    let tenantId;
    if (leadId) {
      const lead = await Lead.findById(leadId);
      tenantId = lead?.tenantId;
    }
    if (!tenantId) {
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id;
      }
    }

    const notification = new Notification({
      tenantId,
      leadId,
      channel: 'SMS',
      message: text,
      status: 'Sent',
      sentAt: new Date(),
    });
    await notification.save();

    const io = getIO();
    if (io) {
      io.to('/crm').emit('notification:sent', {
        leadId,
        channel: 'SMS',
        message: `SMS Sent to ${to}: ${text}`,
        timestamp: new Date(),
      });
    }

    const twilioSid = process.env.TWILIO_SID;
    const twilioToken = process.env.TWILIO_TOKEN;
    const twilioFrom = process.env.TWILIO_FROM;

    if (twilioSid && twilioToken && twilioFrom && !twilioSid.startsWith('mock')) {
      const client = require('twilio')(twilioSid, twilioToken);
      await client.messages.create({
        body: text,
        from: twilioFrom,
        to,
      });
    }

    return true;
  } catch (error: any) {
    console.error('Error sending SMS:', error.message);
    return false;
  }
};
