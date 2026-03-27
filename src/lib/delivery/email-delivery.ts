/**
 * Email Delivery Service
 * Sends reports via email using SMTP
 */

interface EmailOptions {
  to: string
  subject: string
  text?: string
  html?: string
  attachments?: Array<{
    filename: string
    content: string | Buffer
    contentType?: string
  }>
}

let nodemailer: any = null

/**
 * Initialize nodemailer (lazy load to avoid requiring it if not configured)
 */
function getNodemailer() {
  if (!nodemailer) {
    try {
      nodemailer = require('nodemailer')
    } catch (error) {
      // nodemailer not installed
      return null
    }
  }
  return nodemailer
}

/**
 * Create email transporter from environment variables
 */
function createTransporter() {
  const mailer = getNodemailer()
  if (!mailer) {
    return null
  }

  const smtpHost = process.env.SMTP_HOST
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10)
  const smtpUser = process.env.SMTP_USER
  const smtpPassword = process.env.SMTP_PASSWORD
  const smtpSecure = process.env.SMTP_SECURE === 'true'

  if (!smtpHost || !smtpUser || !smtpPassword) {
    return null
  }

  return mailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure, // true for 465, false for other ports
    auth: {
      user: smtpUser,
      pass: smtpPassword,
    },
  })
}

/**
 * Send email
 */
export async function sendEmail(options: EmailOptions): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = createTransporter()
    if (!transporter) {
      return {
        success: false,
        error: 'Email service not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD environment variables.',
      }
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      attachments: options.attachments,
    }

    await transporter.sendMail(mailOptions)
    return { success: true }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to send email',
    }
  }
}

/**
 * Send report via email
 */
export async function sendReportEmail(
  to: string,
  report: any,
  reportContent?: string | Buffer
): Promise<{ success: boolean; error?: string }> {
  const subject = `Laboratory Report - ${report.reportNumber || report.id}`
  const text = `Please find attached the laboratory report ${report.reportNumber || report.id}.\n\nGenerated on: ${report.generatedOn}\nPatient ID: ${report.patientId}`
  const html = `
    <html>
      <body>
        <h2>Laboratory Report</h2>
        <p>Please find attached the laboratory report <strong>${report.reportNumber || report.id}</strong>.</p>
        <p><strong>Generated on:</strong> ${new Date(report.generatedOn).toLocaleString()}</p>
        <p><strong>Patient ID:</strong> ${report.patientId}</p>
        ${report.title ? `<p><strong>Title:</strong> ${report.title}</p>` : ''}
      </body>
    </html>
  `

  const attachments = []
  if (reportContent) {
    const filename = `${report.reportNumber || report.id}.${report.format?.toLowerCase() || 'pdf'}`
    attachments.push({
      filename,
      content: reportContent,
      contentType: report.contentType || 'application/pdf',
    })
  }

  return sendEmail({
    to,
    subject,
    text,
    html,
    attachments: attachments.length > 0 ? attachments : undefined,
  })
}

/**
 * Send one-time external access link email (24h link for doctor/lab)
 */
export async function sendExternalAccessLinkEmail(
  to: string,
  link: string,
  type: 'VIEW_RECORD' | 'UPDATE_LABS',
  expiresInHours: number = 24
): Promise<{ success: boolean; error?: string }> {
  const typeLabel = type === 'VIEW_RECORD' ? 'view this patient\'s record' : 'update lab results for this patient'
  const subject = `One-time access link - ${type === 'VIEW_RECORD' ? 'View record' : 'Update labs'}`
  const text = `You have been granted one-time access to ${typeLabel}. This link expires in ${expiresInHours} hours.\n\n${link}\n\nDo not share this link.`
  const html = `
    <html>
      <body>
        <h2>One-time access link</h2>
        <p>You have been granted one-time access to ${typeLabel}.</p>
        <p>This link expires in <strong>${expiresInHours} hours</strong>.</p>
        <p><a href="${link}">${link}</a></p>
        <p>Do not share this link.</p>
      </body>
    </html>
  `
  return sendEmail({ to, subject, text, html })
}

