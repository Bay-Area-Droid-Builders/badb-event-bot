import nodemailer from "nodemailer";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Sends from the club Gmail account over SMTP with an app password.
export async function sendEmail(email: Email): Promise<void> {
  const user = process.env.GMAIL_SENDER_EMAIL;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_SENDER_EMAIL / GMAIL_APP_PASSWORD is not set");

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transporter.sendMail({ from: `Bay Area Droid Builders <${user}>`, ...email });
}
