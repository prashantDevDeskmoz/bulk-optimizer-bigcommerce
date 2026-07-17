const mongoose = require("mongoose");

const planSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    description: {
        type: String,
        required: true,
    },
    itemLimit: {
        type: Number,
        default: null,  // null = unlimited
    },
    period: {
        type: String,
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
    paypalPlanId: {
        type: String,
        default: null,
    },
});

const Plan = mongoose.model("Plan", planSchema);


module.exports = Plan;