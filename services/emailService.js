const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT) || 587,
    secure: process.env.EMAIL_SMTP_SECURE === "true",
    auth: {
        user: process.env.EMAIL_SMTP_USER,
        pass: process.env.EMAIL_SMTP_PASSWORD,
    },
});

const sendInstallNotificationEmail = async (storeHash, email, storeName) => {
    try {
        if (!email) {
            console.warn("sendInstallNotificationEmail: no email for store", storeHash);
            return false;
        }

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: "prashantsingh.deskmoz@gmail.com",
            subject: "Bulk Optimizer is installed and ready",
            html: `
                <div style="margin:0;padding:0;background-color:#f4f5f7;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 0;">
                    <tr>
                    <td align="center">
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
                        <tr>
                            <td style="background-color:#4f46e5;padding:28px 32px;">
                            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Bulk Optimizer</h1>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding:32px;">
                            <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">You're all set 🎉</h2>
                            <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                                Thanks for installing <strong>Bulk Optimizer</strong> on your store
                                <strong>${storeName}</strong>.
                            </p>
                            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
                                You can now bulk optimize your product, category, and brand titles,
                                meta descriptions, and image alt text right from your BigCommerce admin.
                            </p>
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                <td style="border-radius:8px;background-color:#4f46e5;">
                                    <a href="${process.env.FRONTEND_BASE_URL}"
                                    style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">
                                    Open Bulk Optimizer
                                    </a>
                                </td>
                                </tr>
                            </table>
                            <p style="margin:28px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">
                                Need help? Just reply to this email — we're happy to assist.
                            </p>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
                            <p style="margin:0;color:#9ca3af;font-size:12px;">
                                — The Bulk Optimizer Team
                            </p>
                            </td>
                        </tr>
                        </table>
                    </td>
                    </tr>
                </table>
                </div>
            `,
        });

        console.log("sendInstallNotificationEmail: Email sent to", email);
        return true;
    } catch (error) {
        console.error("sendInstallNotificationEmail:", error.message);
        return false;
    }
}

module.exports = {
    sendInstallNotificationEmail,
}
