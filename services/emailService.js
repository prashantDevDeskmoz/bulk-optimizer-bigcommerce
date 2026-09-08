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

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const detailRow = (label, value, { mono = false, first = false } = {}) => {
    const safe = escapeHtml(value || "N/A");
    const border = first ? "" : "border-top:1px solid #e5e7eb;";
    const valueStyle = mono
        ? `padding:12px 16px;color:#111827;font-size:14px;${border}font-family:monospace;`
        : `padding:12px 16px;color:#111827;font-size:14px;${border}`;
    return `
        <tr>
            <td style="padding:12px 16px;background-color:#f9fafb;color:#6b7280;font-size:13px;width:140px;${border}">${escapeHtml(label)}</td>
            <td style="${valueStyle}">${safe}</td>
        </tr>
    `;
};

const buildStoreDetailsTable = ({ name, email, address, storeUrl, storeHash }) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        ${detailRow("Name", name, { first: true })}
        ${detailRow("Email", email)}
        ${detailRow("Address", address)}
        ${detailRow("Store Url", storeUrl)}
        ${detailRow("Store Hash", storeHash, { mono: true })}
        ${detailRow("Platform", "Bigcommerce")}
    </table>
`;

const buildNotificationHtml = ({ headerBg, title, intro, details }) => `
    <div style="margin:0;padding:0;background-color:#f4f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 0;">
        <tr>
        <td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <tr>
                <td style="background-color:${headerBg};padding:28px 32px;">
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Bulk Optimizer</h1>
                </td>
            </tr>
            <tr>
                <td style="padding:32px;">
                <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">${escapeHtml(title)}</h2>
                <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
                    ${intro}
                </p>
                ${buildStoreDetailsTable(details)}
                </td>
            </tr>
            </table>
        </td>
        </tr>
    </table>
    </div>
`;

const normalizeDetails = ({ storeHash, email, name, address, storeUrl } = {}) => ({
    name: name || "N/A",
    email: email || "N/A",
    address: address || "N/A",
    storeUrl: storeUrl || "N/A",
    storeHash: storeHash || "N/A",
});

// Internal alert when a merchant installs Bulk Optimizer (sent to the team, not the merchant)
const sendInstallNotificationEmail = async (details = {}) => {
    try {
        const safe = normalizeDetails(details);
        if (!details.email) {
            console.warn("sendInstallNotificationEmail: no email for store", safe.storeHash);
        }

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: "info@seokart.com",
            cc: "prashantsingh.deskmoz@gmail.com",
            subject: `New install: ${safe.name} (${safe.storeHash})`,
            html: buildNotificationHtml({
                headerBg: "#4f46e5",
                title: "New app installation",
                intro: "A merchant just installed <strong>Bulk Optimizer</strong> on their BigCommerce store.",
                details: safe,
            }),
        });

        console.log("sendInstallNotificationEmail: Internal alert sent for", safe.storeHash, "to info@seokart.com");
        return true;
    } catch (error) {
        console.error("sendInstallNotificationEmail:", error.message);
        return false;
    }
};

// Internal alert when a merchant uninstalls Bulk Optimizer (sent to the team, not the merchant)
const sendUninstallNotificationEmail = async (details = {}) => {
    try {
        const safe = normalizeDetails(details);

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: "info@seokart.com",
            cc: "prashantsingh.deskmoz@gmail.com",
            subject: `Uninstall: ${safe.name} (${safe.storeHash})`,
            html: buildNotificationHtml({
                headerBg: "#dc2626",
                title: "App uninstalled",
                intro: "A merchant just uninstalled <strong>Bulk Optimizer</strong> from their BigCommerce store.",
                details: safe,
            }),
        });

        console.log("sendUninstallNotificationEmail: Internal alert sent for", safe.storeHash, "to info@seokart.com");
        return true;
    } catch (error) {
        console.error("sendUninstallNotificationEmail:", error.message);
        return false;
    }
};

module.exports = {
    sendInstallNotificationEmail,
    sendUninstallNotificationEmail,
};
