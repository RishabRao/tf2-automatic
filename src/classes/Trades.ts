import TradeOfferManager, { EconItem } from 'steam-tradeoffer-manager';
import { UnknownDictionaryKnownValues, UnknownDictionary } from '../types/common';
import moment from 'moment';
import pluralize from 'pluralize';

import Bot from './Bot';

import log from '../lib/logger';
import { exponentialBackoff } from '../lib/helpers';

export = class Trades {
    private readonly bot: Bot;

    private itemsInTrade: string[] = [];
    private receivedOffers: number[] = [];
    private processingOffer: boolean = false;
    private pollCount: number = 0;

    constructor (bot: Bot) {
        this.bot = bot;
    }

    onPollData (pollData: TradeOfferManager.PollData): void {
        this.bot.handler.onPollData(pollData);
    }

    setPollData (pollData: TradeOfferManager.PollData): void {
        const activeOrCreatedNeedsConfirmation: string[] = [];

        for (const id in pollData.sent) {
            if (!Object.prototype.hasOwnProperty.call(pollData.sent, id)) {
                continue;
            }
    
            const state = pollData.sent[id];
    
            if (state === TradeOfferManager.ETradeOfferState.Active || state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) {
                activeOrCreatedNeedsConfirmation.push(id);
            }
        }
    
        for (const id in pollData.received) {
            if (!Object.prototype.hasOwnProperty.call(pollData.received, id)) {
                continue;
            }
    
            const state = pollData.received[id];
    
            if (state === TradeOfferManager.ETradeOfferState.Active) {
                activeOrCreatedNeedsConfirmation.push(id);
            }
        }
    
        // Go through all sent / received offers and mark the items as in trade
        for (let i = 0; i < activeOrCreatedNeedsConfirmation.length; i++) {
            const id = activeOrCreatedNeedsConfirmation[i];
    
            const offerData: UnknownDictionaryKnownValues = pollData.offerData === undefined ? {} : (pollData.offerData[id] || {});
            const items = <TradeOfferManager.TradeOfferItem[]>(offerData.items || []);
    
            for (let i = 0; i < items.length; i++) {
                this.setItemInTrade(items[i].assetid);
            }
        }

        this.bot.manager.pollData = pollData;
    }

    onNewOffer (offer: TradeOfferManager.TradeOffer): void {
        if (offer.isGlitched()) {
            offer.log('debug', 'is glitched');
            return;
        }

        offer.log('info', 'received offer');

        offer.itemsToGive.forEach((item) => this.setItemInTrade(item.assetid));

        offer.data('partner', offer.partner.getSteamID64());

        this.enqueueOffer(offer);
    }

    onOfferList (filter: number, sent: TradeOfferManager.TradeOffer[], received: TradeOfferManager.TradeOffer[]): void {
        // Go through all offers and add offers that we have not checked

        this.pollCount++;

        const activeReceived = received.filter((offer) => offer.state === TradeOfferManager.ETradeOfferState.Active);

        if (filter === TradeOfferManager.EOfferFilter.ActiveOnly && (this.pollCount * this.bot.manager.pollInterval) / (2 * 60 * 1000) >= 1) {
            this.pollCount = 0;

            const activeSent = sent.filter((offer) => offer.state === TradeOfferManager.ETradeOfferState.Active);

            const receivedOnHold = received.filter((offer) => offer.state === TradeOfferManager.ETradeOfferState.InEscrow).length;
            const sentOnHold = sent.filter((offer) => offer.state === TradeOfferManager.ETradeOfferState.InEscrow).length;

            log.verbose(activeReceived.length + ' incoming ' + pluralize('offer', activeReceived.length) + ' (' + receivedOnHold + ' on hold), ' + activeSent.length + ' outgoing ' + pluralize('offer', activeSent.length) + ' (' + sentOnHold + ' on hold)');
        }

        activeReceived.filter((offer) => offer.data('handledByUs') !== true).forEach((offer) => this.enqueueOffer(offer));
    }

    private enqueueOffer (offer: TradeOfferManager.TradeOffer) {
        if (this.receivedOffers.indexOf(offer.id) === -1) {
            this.receivedOffers.push(offer.id);

            if (this.receivedOffers.length === 1) {
                this.processingOffer = true;

                this.handlerProcessOffer(offer);
            } else {
                this.processNextOffer();
            }
        }
    }

    private dequeueOffer (offerId: number): void {
        const index = this.receivedOffers.indexOf(offerId);

        if (index !== -1) {
            this.receivedOffers.splice(index, 1);
        }
    }

    private handlerProcessOffer (offer: TradeOfferManager.TradeOffer) {
        log.debug('Giving offer to handler');

        const start = moment().valueOf();

        offer.data('handleTimestamp', start);

        this.bot.handler.onNewTradeOffer(offer).asCallback((err, response) => {
            if (err) {
                log.debug('Error occurred while handler was processing offer: ', err);
                throw err;
            }

            offer.data('handleTime', moment().valueOf() - start);

            offer.log('debug', 'handler is done with offer', { response: response });

            let actionFunc: Function;

            if (response.action === 'accept') {
                actionFunc = this.acceptOffer;
            } else if (response.action === 'decline') {
                actionFunc = this.declineOffer;
            }

            offer.data('action', response);

            actionFunc.call(this, offer).asCallback((err) => {
                if (err) {
                    log.warn('Failed to ' + response.action + ' the offer: ', err);
                    return;
                }
                
                offer.log('debug', 'done doing action on offer', { action: response.action });

                this.finishProcessingOffer(offer.id);
            });
        });
    }

    private finishProcessingOffer (offerId): void {
        this.dequeueOffer(offerId);
        this.processingOffer = false;
        this.processNextOffer();
    }

    private processNextOffer (): void {
        if (this.processingOffer || this.receivedOffers.length === 0) {
            return;
        }
    
        this.processingOffer = true;
    
        const offerId = this.receivedOffers[0];
    
        log.verbose('Handling offer #' + offerId + '...');
    
        this.fetchOffer(offerId).asCallback((err, offer) => {
            if (err) {
                log.warn('Failed to get offer #' + offerId + ': ', err);
                // After many retries we could not get the offer data
    
                if (this.receivedOffers.length !== 1) {
                    // Remove the offer from the queue and add it to the back of the queue
                    this.receivedOffers.push(offerId);
                }
            }
    
            if (!offer) {
                // Failed to get the offer
                this.finishProcessingOffer(offerId);
            } else {
                // Got the offer, give it to the handler
                this.handlerProcessOffer(offer);
            }
        });
    }

    fetchOffer (offerId: number, attempts: number = 0): Promise<TradeOfferManager.TradeOffer> {
        return new Promise((resolve, reject) => {
            this.bot.manager.getOffer(offerId, (err, offer) => {
                attempts++;
                if (err) {
                    if (err.message === 'NoMatch' || err.message === 'No matching offer found') {
                        // The offer does not exist
                        return resolve(null);
                    }
        
                    if (attempts > 5) {
                        // Too many retries
                        return reject(err);
                    }
        
                    if (err.message !== 'Not Logged In') {
                        // We got an error getting the offer, retry after some time
                        Promise.delay(exponentialBackoff(attempts)).then(() => {
                            resolve(this.fetchOffer(offerId, attempts));
                        });
                        return;
                    }

                    this.bot.getWebSession(true).asCallback((err) => {
                        // If there is no error when waiting for web session, then attempt to fetch the offer right away
                        Promise.delay(err !== null ? 0 : exponentialBackoff(attempts)).then(() => {
                            resolve(this.fetchOffer(offerId, attempts));
                        });
                    });
                    return;
                }

                if (offer.state !== TradeOfferManager.ETradeOfferState.Active) {
                    // Offer is not active
                    return resolve(null);
                }

                // Got offer
                return resolve(offer);
            });
        });
    }

    private acceptOffer (offer: TradeOfferManager.TradeOffer): Promise<string> {
        return new Promise ((resolve, reject) => {
            offer.data('handledByUs', true);

            const start = moment().valueOf();
            offer.data('actionTimestamp', start);

            this.acceptOfferRetry(offer).asCallback((err, status) => {
                const actionTime = moment().valueOf() - start;
                offer.data('actionTime', actionTime);

                if (err) {
                    return reject(err);
                }

                offer.log('trade', 'successfully accepted' + (status === 'pending' ? '; confirmation required': ''));

                if (status === 'pending') {
                    // Maybe wait for confirmation to be accepted and then resolve?
                    this.acceptConfirmation(offer).catch();
                }

                return resolve(status);
            });
        });
    }

    private acceptConfirmation (offer: TradeOfferManager.TradeOffer): Promise<void> {
        return new Promise((resolve, reject) => {
            log.debug('Accepting mobile confirmation...', { offer_id: offer.id });

            const start = moment().valueOf();
            offer.data('actedOnConfirmation', true);
            offer.data('actedOnConfirmationTimestamp', start);

            this.bot.community.acceptConfirmationForObject(process.env.STEAM_IDENTITY_SECRET, offer.id, (err) => {
                const confirmationTime = moment().valueOf() - start;
                offer.data('confirmationTime', confirmationTime);

                if (err) {
                    log.debug('Error while trying to accept mobile confirmation: ', err);
                    return reject(err);
                }

                return resolve();
            });
        });
    }

    private acceptOfferRetry (offer: TradeOfferManager.TradeOffer, attempts: number = 0): Promise<string> {
        return new Promise ((resolve, reject) => {
            offer.accept((err, status) => {
                attempts++;

                if (err) {
                    // @ts-ignore
                    if (err.eresult !== undefined || attempts > 5) {
                        return reject(err);
                    }

                    if (err.message !== 'Not Logged In') {
                        // We got an error getting the offer, retry after some time
                        Promise.delay(exponentialBackoff(attempts)).then(() => {
                            resolve(this.acceptOfferRetry(offer, attempts));
                        });
                        return;
                    }

                    this.bot.getWebSession(true).asCallback((err) => {
                        // If there is no error when waiting for web session, then attempt to fetch the offer right away
                        Promise.delay(err !== null ? 0 : exponentialBackoff(attempts)).then(() => {
                            resolve(this.acceptOfferRetry(offer, attempts));
                        });
                    });
                    return;
                }

                return resolve(status);
            });
        });
    }

    private declineOffer (offer: TradeOfferManager.TradeOffer): Promise<void> {
        return new Promise((resolve, reject) => {
            offer.data('handledByUs', true);

            const start = moment().valueOf();
            offer.data('actionTimestamp', start);

            offer.decline((err) => {
                const actionTime = moment().valueOf() - start;
                offer.data('actionTime', actionTime);

                if (err) {
                    return reject(err);
                }

                return resolve();
            });
        });
    }

    onOfferChanged (offer: TradeOfferManager.TradeOffer, oldState: number): void {
        offer.log('verbose', 'state changed: ' + TradeOfferManager.ETradeOfferState[oldState] + ' -> ' + TradeOfferManager.ETradeOfferState[offer.state]);

        if (offer.state === TradeOfferManager.ETradeOfferState.Active || offer.state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) {
            // Offer is active

            // Mark items as in trade
            offer.itemsToGive.forEach((item) => this.setItemInTrade(item.id));

            if (offer.isOurOffer && offer.data('_ourItems') === null) {
                // Items are not saved for sent offer, save them
                offer.data('_ourItems', offer.itemsToGive.map((item) => this.mapItem(item)));
            }
        } else {
            // Offer is not active and the items are no longer in trade
            offer.itemsToGive.forEach((item) => this.unsetItemInTrade(item.assetid));

            // Unset items
            offer.data('_ourItems', undefined);

            const finishTimestamp = moment().valueOf();

            offer.data('finishTimestamp', finishTimestamp);

            const processTime = finishTimestamp - offer.data('handleTimeStamp');

            log.debug('Took ' + (isNaN(processTime) ? 'unknown' : processTime) + ' ms to process offer', { offer_id: offer.id, state: offer.state, finish_time: processTime });
        }

        if (offer.state !== TradeOfferManager.ETradeOfferState.Accepted && offer.state !== TradeOfferManager.ETradeOfferState.InEscrow) {
            // The offer was not accepted
            this.bot.handler.onTradeOfferChanged(offer, oldState);
            return;
        }
        
        offer.itemsToGive.forEach((item) => this.bot.inventoryManager.getInventory().removeItem(item.assetid));

        this.bot.inventoryManager.getInventory().fetch().asCallback(() => {
            this.bot.getHandler().onTradeOfferChanged(offer, oldState);
        });
    }

    private mapItem (item: EconItem): TradeOfferManager.TradeOfferItem {
        return {
            appid: item.appid,
            contextid: item.contextid,
            assetid: item.assetid,
            amount: item.amount
        };
    }

    private setItemInTrade (assetid: string): void {
        const index = this.itemsInTrade.indexOf(assetid);

        if (index === -1) {
            this.itemsInTrade.push(assetid);
        }
    }

    private unsetItemInTrade (assetid: string): void {
        const index = this.itemsInTrade.indexOf(assetid);

        if (index !== -1) {
            this.itemsInTrade.splice(index, 1);
        }
    }
}