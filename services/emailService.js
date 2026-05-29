const sendInstallNotificationEmail = async (storeHash, email) => {
    try{
        await new Promise (resolve => setTimeout(resolve, 1000));
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