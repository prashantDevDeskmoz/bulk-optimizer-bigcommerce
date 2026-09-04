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


// Internal alert when a merchant installs Bulk Optimizer (sent to the team, not the merchant)
const sendInstallNotificationEmail = async (storeHash, email, storeName) => {
    try {
        if (!email) {
            console.warn("sendInstallNotificationEmail: no email for store", storeHash);
            return false;
        }

        const safeStoreName = storeName || "Unknown store";
        const safeEmail = email || "N/A";
        const safeStoreHash = storeHash || "N/A";

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: "info@seokart.com",
            subject: `New install: ${safeStoreName} (${safeStoreHash})`,
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
                            <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">New app installation</h2>
                            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
                                A merchant just installed <strong>Bulk Optimizer</strong> on their BigCommerce store.
                            </p>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                                <tr>
                                    <td style="padding:12px 16px;background-color:#f9fafb;color:#6b7280;font-size:13px;width:140px;">Store name</td>
                                    <td style="padding:12px 16px;color:#111827;font-size:14px;font-weight:600;">${safeStoreName}</td>
                                </tr>
                                <tr>
                                    <td style="padding:12px 16px;background-color:#f9fafb;color:#6b7280;font-size:13px;border-top:1px solid #e5e7eb;">Store hash</td>
                                    <td style="padding:12px 16px;color:#111827;font-size:14px;border-top:1px solid #e5e7eb;font-family:monospace;">${safeStoreHash}</td>
                                </tr>
                                <tr>
                                    <td style="padding:12px 16px;background-color:#f9fafb;color:#6b7280;font-size:13px;border-top:1px solid #e5e7eb;">Merchant email</td>
                                    <td style="padding:12px 16px;color:#111827;font-size:14px;border-top:1px solid #e5e7eb;">
                                        <a href="mailto:${safeEmail}" style="color:#4f46e5;text-decoration:none;">${safeEmail}</a>
                                    </td>
                                </tr>
                            </table>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
                            <p style="margin:0;color:#9ca3af;font-size:12px;">
                                Internal notification — Bulk Optimizer
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

        console.log("sendInstallNotificationEmail: Internal alert sent for", safeStoreHash, "to info@seokart.com");
        return true;
    } catch (error) {
        console.error("sendInstallNotificationEmail:", error.message);
        return false;
    }
}

module.exports = {
    sendInstallNotificationEmail,
}
