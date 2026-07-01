const mongoose = require("mongoose");

// oldest = 1, recent = 2
const itemSnapshotSchema = new mongoose.Schema({
    storeHash: { type: String, required: true },
    itemId: { type: Number, required: true },
    bcChannelId: { type: Number },
    jobHistoryId: { type: String, required: true },
    //will be used later for if more than 1 snapshots are needed for a single item
    //slot: { type: Number, required: true, enum: [1, 2] }, // oldest = 1, recent = 2
    itemType: { type: String, required: true, enum: ["product", "category", "brand"] },
    capturedAt: { type: Date, required: true },
    target: { type: String, enum: ["title", "meta", "alt"], default: null },
    fields: { 
        page_title: { type: String },
        meta_description: { type: String },
        alt_text: { type: String },
        name: { type: String, required: true },
        item_url: { type: String, required: true },
        images : [{
            imageId : Number,
            altText : String,
        }]
    },
    // is_restored: { type: Boolean, default: false },
    //will be used later for if more than 1 snapshots are needed for a single item
});       

itemSnapshotSchema.index(
    { storeHash: 1, itemType: 1, target: 1 }
);

itemSnapshotSchema.index(
    { storeHash: 1, itemType: 1, target: 1, itemId: 1 },{unique: true}
);

const ItemSnapshot = mongoose.model("item_snapshot", itemSnapshotSchema);
module.exports = ItemSnapshot;