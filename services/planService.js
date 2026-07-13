const JobHistory = require("../models/JobHistory");
const Plan = require("../models/Plan");

const getPlanAndCheckLimit = async (store) => {
    // use cirular monthly limit logic

    function addMonthsClamped(date, months) {
        const d = new Date(date);
        const targetDay = d.getDate(); // 31
        d.setMonth(d.getMonth() + months);
        if (d.getDate() !== targetDay) {
          // overflow happened, go back to last day of intended month
          d.setDate(0); // 0 = last day of previous month
        }
        return d;
      }
      
    try{
        const plan = await Plan.findOne({ name: store.plan });
        if(!plan) {
            throw new Error("Plan not found");
        }

        const baseDate = (store.plan === "free") 
          ? new Date(store.createdAt) 
          : new Date(store.planPurchasedAt || store.createdAt);

        const now = new Date(); // 7 march 2026
      
        // Calculate start of the current monthly cycle
        let monthsSinceBase = 
        (now.getFullYear() * 12 + now.getMonth()) -
        (baseDate.getFullYear() * 12 + baseDate.getMonth());
    
        if(now.getDate() < baseDate.getDate()) {
            monthsSinceBase--;
        }

        const cycleStart = addMonthsClamped(baseDate, monthsSinceBase);
        const cycleEnd = addMonthsClamped(cycleStart, 1);

        const aggregateResult = await JobHistory.aggregate([
            { $match: 
                { storeHash: store.store_hash, status: {$in: ["completed", "failed", "pending"]}, startedAt : {$gte : cycleStart , $lt : cycleEnd} }
            },
            { $group:
                 { _id: "$storeHash", totalItems: { $sum: "$processedItems" } }  
            },
        ]);


        const totalItemsProcessed = aggregateResult[0]?.totalItems || 0;

        if (plan.itemLimit == null) {
            return { planLimitReached: false, usage: totalItemsProcessed, canBeUpdated: null, planLimit: null };
        }

        const planLimitReached = totalItemsProcessed >= plan.itemLimit;
        const canBeUpdated = Math.max(0, plan.itemLimit - totalItemsProcessed);

        return { planLimitReached, usage: totalItemsProcessed, canBeUpdated, planLimit: plan.itemLimit };

    } catch (error) {
        console.error(error);
        throw new Error("Error getting plan and checking limit");
    }
}

const ensureDefaultPlans = async () => {
    await Plan.find({name: {$in: ["free", "pro"]}}).then(async (plans) => {
        if(plans.length === 0) {
            await Plan.insertMany([
                {name: "free", description: "Free plan", itemLimit: 100, period: "monthly", price: 0},
                {name: "pro", description: "Pro plan", itemLimit: null, period: "monthly", price: 20},
            ]);
        }
    });
};

module.exports = {
    getPlanAndCheckLimit,
    ensureDefaultPlans,
}