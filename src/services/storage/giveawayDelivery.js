import {TitanBotError,ErrorTypes} from '../../utils/errorHandler.js';
import {isSQLiteGiveawayBackend} from './sqliteGiveaways.js';
import {saveGiveaway} from '../../utils/giveaways.js';

// Discord and SQLite cannot be committed together. Do not retry a delivery
// with an unknown outcome automatically. Snapshot-guarded save is required.
export function prepareGiveawayDelivery(client,giveaway,action){
 if(!isSQLiteGiveawayBackend(client))return;
 if(giveaway.deliveryStatus!=null&&giveaway.deliveryStatus!=='delivered')throw new TitanBotError('Prior giveaway delivery is unresolved',ErrorTypes.DATABASE,'A prior giveaway delivery is pending or unknown. Inspect Discord and reconcile it before trying again.');
 giveaway.deliveryStatus='pending';giveaway.deliveryAction=action;
}
export async function completeGiveawayDelivery(client,guildId,giveaway){
 if(!isSQLiteGiveawayBackend(client))return;
 giveaway.deliveryStatus='delivered';
 try {if(!await saveGiveaway(client,guildId,giveaway))throw new Error('Delivery status not saved');}
 catch(error){throw new TitanBotError('Giveaway delivered but status could not be saved',ErrorTypes.DATABASE,'Discord may have been updated, but delivery status could not be saved. Inspect before retrying.');}
}
