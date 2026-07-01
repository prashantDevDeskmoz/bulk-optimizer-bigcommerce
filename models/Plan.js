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
        required: true,
    },
    period: {
        type: String,
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
});

const Plan = mongoose.model("Plan", planSchema);


module.exports = Plan;