'use strict';

import * as util from 'util';

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
import * as db from '../database';

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
import * as plugins from '../plugins';

interface Reward {
    id: string;
    claimable: number;
    disabled?: boolean | string;
    conditional?: string;
    value?: any;
    rid: string;
}

interface Params {
    uid: string;
    condition: string;
    method: (...args: any[]) => Promise<any> | any;
}

const rewards: any = {};

rewards.checkConditionAndRewardUser = async function (params: Params): Promise<void> {
    const { uid, condition, method } = params;
    const isActive = await isConditionActive(condition);
    if (!isActive) {
        return;
    }
    const ids = await getIDsByCondition(condition);
    let rewardData = await getRewardDataByIDs(ids);
    
    // filter disabled rewards
    rewardData = rewardData.filter(r => r && !(r.disabled === 'true' || r.disabled === true));
    rewardData = await filterCompletedRewards(uid, rewardData);
    
    if (!rewardData || !rewardData.length) {
        return;
    }
    
    const eligible = await Promise.all(rewardData.map(reward => checkCondition(reward, method)));
    const eligibleRewards = rewardData.filter((reward, index) => eligible[index]);
    await giveRewards(uid, eligibleRewards);
};

async function isConditionActive(condition: string): Promise<boolean> {
    return await db.isSetMember('conditions:active', condition);
}

async function getIDsByCondition(condition: string): Promise<string[]> {
    return await db.getSetMembers(`condition:${condition}:rewards`);
}

async function filterCompletedRewards(uid: string, rewards: Reward[]): Promise<Reward[]> {
    const data = await db.getSortedSetRangeByScoreWithScores(`uid:${uid}:rewards`, 0, -1, 1, '+inf');
    const userRewards: Record<string, number> = {};

    data.forEach((obj: { value: string; score: string }) => {
        userRewards[obj.value] = parseInt(obj.score, 10);
    });

    return rewards.filter((reward) => {
        if (!reward) {
            return false;
        }

        const claimable = parseInt(reward.claimable.toString(), 10);
        return claimable === 0 || (!userRewards[reward.id] || userRewards[reward.id] < claimable);
    });
}

async function getRewardDataByIDs(ids: string[]): Promise<Reward[]> {
    return await db.getObjects(ids.map(id => `rewards:id:${id}`));
}

async function getRewardsByRewardData(rewards: Reward[]): Promise<Reward[]> {
    return await db.getObjects(rewards.map(reward => `rewards:id:${reward.id}:rewards`));
}

async function checkCondition(reward: Reward, method: (...args: any[]) => Promise<any>): Promise<boolean> {
    if (method.constructor && method.constructor.name !== 'AsyncFunction') {
        method = util.promisify(method);
    }
    const value = await method();
    const bool = await plugins.hooks.fire(`filter:rewards.checkConditional:${reward.conditional}`, { left: value, right: reward.value });
    return bool;
}

async function giveRewards(uid: string, rewards: Reward[]): Promise<void> {
    const rewardData = await getRewardsByRewardData(rewards);
    for (let i = 0; i < rewards.length; i++) {
        /* eslint-disable no-await-in-loop */
        await plugins.hooks.fire(`action:rewards.award:${rewards[i].rid}`, {
            uid: uid,
            rewardData: rewards[i],
            reward: rewardData[i],
        });
        await db.sortedSetIncrBy(`uid:${uid}:rewards`, 1, rewards[i].id);
    }
}

require('../promisify')(rewards);

export default rewards;
