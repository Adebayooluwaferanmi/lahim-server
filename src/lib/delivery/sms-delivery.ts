/**
 * SMS Delivery Service
 * Sends reports via SMS using Twilio or similar service
 */

interface SMSOptions {
  to: string
  message: string
}

let twilioClient: any = null

/**
 * Initialize Twilio client (lazy load to avoid requiring it if not configured)
 */
function getTwilioClient() {
  if (!twilioClient) {
    try {
      const twilio = require('twilio')
      const accountSid = process.env.TWILIO_ACCOUNT_SID
      const authToken = process.env.TWILIO_AUTH_TOKEN

      if (accountSid && authToken) {
        twilioClient = twilio(accountSid, authToken)
      }
    } catch (error) {
      // twilio not installed or not configured
      return null
    }
  }
  return twilioClient
}

/**
 * Send SMS
 */
export async function sendSMS(options: SMSOptions): Promise<{ success: boolean; error?: string; messageId?: string }> {
  try {
    const client = getTwilioClient()
    if (!client) {
      return {
        success: false,
        error: 'SMS service not configured. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.',
      }
    }

    const fromNumber = process.env.TWILIO_PHONE_NUMBER
    if (!fromNumber) {
      return {
        success: false,
        error: 'TWILIO_PHONE_NUMBER environment variable not set',
      }
    }

    // Truncate message to 1600 characters (Twilio supports up to 1600 for long messages)
    const message = options.message.length > 1600 ? options.message.substring(0, 1600) + '...' : options.message

    const result = await client.messages.create({
      body: message,
      from: fromNumber,
      to: options.to,
    })

    return {
      success: true,
      messageId: result.sid,
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to send SMS',
    }
  }
}

/**
 * Send report notification via SMS
 */
export async function sendReportSMS(
  to: string,
  report: any
): Promise<{ success: boolean; error?: string; messageId?: string }> {
  const message = `Lab Report ${report.reportNumber || report.id} is ready. Patient: ${report.patientId}. Generated: ${new Date(report.generatedOn).toLocaleDateString()}. Access via patient portal or contact lab.`
  
  return sendSMS({
    to,
    message,
  })
}

