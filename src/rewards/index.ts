/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import * as util from 'util';
import * as db from '../database';
import * as plugins from '../plugins';
import promisify from '../promisify';


interface Reward {
	id: string;
	disabled?: boolean | string;
	claimable: string;
}

interface RewardData extends Reward {
	conditional: string;
	value: number;
}

interface Params {
	uid: string;
	condition: string;
	method: () => Promise<number> | (() => number);
}

interface DbObject {
	value: string;
	score: string;
}

interface RewardsModule {
	checkConditionAndRewardUser: (params: Params) => Promise<void>;
}

async function isConditionActive(condition: string): Promise<boolean> {
	// eslint-disable-next-line max-len
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
	return await db.isSetMember('conditions:active', condition);
}

async function getIDsByCondition(condition: string): Promise<string[]> {
	return await db.getSetMembers(`condition:${condition}:rewards`);
}

async function filterCompletedRewards(uid: string, rewards: RewardData[]): Promise<RewardData[]> {
	const data: DbObject[] = await db.getSortedSetRangeByScoreWithScores(`uid:${uid}:rewards`, 0, -1, 1, '+inf');
	const userRewards: Record<string, number> = {};

	data.forEach((obj: DbObject) => {
		userRewards[obj.value] = parseInt(obj.score, 10);
	});

	return rewards.filter((reward) => {
		if (!reward) {
			return false;
		}

		const claimable = parseInt(reward.claimable, 10);
		return claimable === 0 || (!userRewards[reward.id] || userRewards[reward.id] < claimable);
	});
}

async function getRewardDataByIDs(ids: string[]): Promise<RewardData[]> {
	return await db.getObjects(ids.map(id => `rewards:id:${id}`));
}

async function getRewardsByRewardData(rewards: RewardData[]): Promise<RewardData[]> {
	return await db.getObjects(rewards.map(reward => `rewards:id:${reward.id}:rewards`));
}

async function checkCondition(reward: RewardData, method: () => Promise<number> | (() => number)): Promise<boolean> {
	if (method.constructor && method.constructor.name !== 'AsyncFunction') {
		method = util.promisify(method as unknown as () => number);
	}
	const value = await method();
	const bool = await plugins.hooks.fire(`filter:rewards.checkConditional:${reward.conditional}`, { left: value, right: reward.value });
	return bool;
}

async function giveRewards(uid: string, rewards: RewardData[]): Promise<void> {
	const rewardData = await getRewardsByRewardData(rewards);
	for (let i = 0; i < rewards.length; i++) {
		/* eslint-disable no-await-in-loop */
		await plugins.hooks.fire(`action:rewards.award:${rewards[i].id}`, {
			uid: uid,
			rewardData: rewards[i],
			reward: rewardData[i],
		});
		await db.sortedSetIncrBy(`uid:${uid}:rewards`, 1, rewards[i].id);
	}
}

const rewards: RewardsModule = {
	async checkConditionAndRewardUser(params: Params): Promise<void> {
		const { uid, condition, method } = params;
		const isActive = await isConditionActive(condition);
		if (!isActive) {
			return;
		}
		const ids = await getIDsByCondition(condition);
		let rewardData: RewardData[] = await getRewardDataByIDs(ids);

		// Filtrar los deshabilitados
		rewardData = rewardData.filter(r => r && !(r.disabled === 'true' || r.disabled === true));
		rewardData = await filterCompletedRewards(uid, rewardData);
		if (!rewardData || !rewardData.length) {
			return;
		}
		const eligible = await Promise.all(rewardData.map(reward => checkCondition(reward, method)));
		const eligibleRewards = rewardData.filter((reward, index) => eligible[index]);
		await giveRewards(uid, eligibleRewards);
	},
};


promisify(rewards);

export = rewards;
