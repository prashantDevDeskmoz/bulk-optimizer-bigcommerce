const mongoose = require("mongoose");

const templateSchema = new mongoose.Schema({
    storeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        required: true,
    },
    bcChannelId: {
        type: String,
        required: true,
    },
    applyTo: {
        type: String,
        enum: ["products", "categories", "brands"],
        required: true,
    },
    target: {
        type: String,
        enum: ["title", "meta", "alt"],
        required: true,
    },
    template: {
        type: String,
        default: null,
    },  
    cruiseControl: {
        type: Boolean,
        default: false,
    },
}, {
    timestamps: true,
});

const Template = mongoose.model("Template", templateSchema);

module.exports = Template;