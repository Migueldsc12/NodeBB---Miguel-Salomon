/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
	const isMember: boolean = await db.isSetMember('conditions:active', condition) as boolean;
	return isMember;
}

async function getIDsByCondition(condition: string): Promise<string[]> {
	const members: string[] = await db.getSetMembers(`condition:${condition}:rewards`) as string[];
	return members;
}

async function filterCompletedRewards(uid: string, rewards: RewardData[]): Promise<RewardData[]> {
	const data = await db.getSortedSetRangeByScoreWithScores(`uid:${uid}:rewards`, 0, -1, 1, '+inf') as DbObject[];
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
	const rewardsData: RewardData[] = await db.getObjects(ids.map(id => `rewards:id:${id}`)) as RewardData[];
	return rewardsData;
}

async function getRewardsByRewardData(rewards: RewardData[]): Promise<RewardData[]> {
	const rewardObjects: RewardData[] = await db.getObjects(rewards.map(reward => `rewards:id:${reward.id}:rewards`)) as RewardData[];
	return rewardObjects;
}

async function checkCondition(reward: RewardData, method: () => Promise<number> | (() => number)): Promise<boolean> {
	if (method.constructor && method.constructor.name !== 'AsyncFunction') {
		method = util.promisify(method as unknown as () => number);
	}
	const value = await method();
	const bool: boolean = await plugins.hooks.fire(`filter:rewards.checkConditional:${reward.conditional}`, { left: value, right: reward.value }) as boolean;
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
