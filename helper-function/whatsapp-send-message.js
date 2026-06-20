var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;

const twilioClient = require('twilio')(accountSid, authToken, {
    lazyLoading: true
});

// Function to send message to WhatsApp
const sendMessage = async (message, senderID) => {

    try {
        await client.messages.create({
            to: senderID,
            body: message,
            from: `whatsapp:+14155238886`
        });
    } catch (error) {
        console.log(`Error at sendMessage --> ${error}`);
    }
};

module.exports = {
    sendMessage
}