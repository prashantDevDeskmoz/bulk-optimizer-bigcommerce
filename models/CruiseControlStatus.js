const mongoose = require("mongoose");

const cruiseControlStatusSchema = new mongoose.Schema({
    storeId : {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        required: true,
    },
    applyTo : {
        type: String,
        enum: ["products", "categories"],
        required: true,
    },
    status : {
        type: Boolean,
        default: false,
    },
    tab : {
        type: String,
        enum: ["title", "meta"],
        required: true,
    }
}, { timestamps: true });

const CruiseControlStatus = mongoose.model("CruiseControlStatus", cruiseControlStatusSchema);

module.exports = CruiseControlStatus;