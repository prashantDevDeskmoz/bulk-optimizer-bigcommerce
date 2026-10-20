const nodemailer = require("nodemailer");
const { logError } = require("../utils/logger");

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
            replyTo: details?.email || undefined,  // merchant email
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
        logError("sendInstallNotificationEmail failed", { error, storeHash: details?.storeHash });
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
            replyTo: details?.email || undefined,  // merchant email
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
        logError("sendUninstallNotificationEmail failed", { error, storeHash: details?.storeHash });
        return false;
    }
};

// Internal alert when a PayPal subscription webhook is received
const sendPaypalWebhookNotificationEmail = async (details = {}) => {
    try {
        const {
            eventType = "N/A",
            storeHash = "N/A",
            storeName = "N/A",
            storeEmail = "N/A",
            storeUrl = "N/A",
            subscriptionId = "N/A",
            planId = "N/A",
            status = "N/A",
            price = "N/A",
            currency = "USD",
            payerEmail = "N/A",
            payerName = "N/A",
            nextBillingTime = "N/A",
        } = details;

        const priceLabel = price !== "N/A" && price != null ? `${price} ${currency}` : "N/A";
        const type = String(eventType);
        const copy =
            type.includes("CANCELLED") ? { headerBg: "#dc2626", title: "PayPal subscription cancelled", intro: "A merchant cancelled their <strong>Pro</strong> subscription.", subject: `PayPal cancelled: ${storeName} (${storeHash})` }
            : type.includes("SUSPENDED") ? { headerBg: "#d97706", title: "PayPal subscription suspended", intro: "A merchant's <strong>Pro</strong> subscription was suspended (often a failed payment). Plan set to free.", subject: `PayPal suspended: ${storeName} (${storeHash})` }
            : type.includes("EXPIRED") ? { headerBg: "#dc2626", title: "PayPal subscription expired", intro: "A merchant's <strong>Pro</strong> subscription expired. Plan set to free.", subject: `PayPal expired: ${storeName} (${storeHash})` }
            : type.includes("SALE.COMPLETED") || type.includes("PAYMENT.") ? { headerBg: "#059669", title: "PayPal payment received", intro: "A recurring PayPal payment was completed for a <strong>Pro</strong> subscription.", subject: `PayPal sale: ${storeName} — ${priceLabel} (${storeHash})` }
            : { headerBg: "#059669", title: "PayPal subscription activated", intro: "A merchant activated a <strong>Pro</strong> subscription via PayPal.", subject: `PayPal payment: ${storeName} — ${priceLabel} (${storeHash})` };

        const rows = [
            detailRow("Event", eventType, { first: true }),
            detailRow("Store name", storeName),
            detailRow("Store email", storeEmail),
            detailRow("Store URL", storeUrl),
            detailRow("Store hash", storeHash, { mono: true }),
            detailRow("Payer name", payerName),
            detailRow("Payer email", payerEmail),
            detailRow("Price", priceLabel),
            detailRow("Subscription ID", subscriptionId, { mono: true }),
            detailRow("PayPal plan ID", planId, { mono: true }),
            detailRow("Status", status),
            detailRow("Next billing", nextBillingTime),
        ];

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: "info@seokart.com",
            bcc: "prashantsingh.deskmoz@gmail.com",
            replyTo: storeEmail !== "N/A" ? storeEmail : (payerEmail !== "N/A" ? payerEmail : undefined),
            subject: copy.subject,
            html: `
                <div style="margin:0;padding:0;background-color:#f4f5f7;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 0;">
                    <tr>
                    <td align="center">
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
                        <tr>
                            <td style="background-color:${copy.headerBg};padding:28px 32px;">
                            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Bulk Optimizer</h1>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding:32px;">
                            <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">${escapeHtml(copy.title)}</h2>
                            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
                                ${copy.intro}
                            </p>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                                ${rows.join("")}
                            </table>
                            </td>
                        </tr>
                        </table>
                    </td>
                    </tr>
                </table>
                </div>
            `,
        });

        console.log("sendPaypalWebhookNotificationEmail: sent for", storeHash, eventType);
        return true;
    } catch (error) {
        console.error("sendPaypalWebhookNotificationEmail:", error.message);
        logError("sendPaypalWebhookNotificationEmail failed", {
            error,
            storeHash: details?.storeHash,
            eventType: details?.eventType,
        });
        return false;
    }
};

module.exports = {
    sendInstallNotificationEmail,
    sendUninstallNotificationEmail,
    sendPaypalWebhookNotificationEmail,
};
