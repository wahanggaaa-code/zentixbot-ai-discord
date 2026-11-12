import test from 'node:test';
import assert from 'node:assert/strict';
import buttons from '../src/interactions/buttons/ticket/ticketFeedback.js';
import modal from '../src/interactions/modals/ticket/ticketFeedbackComment.js';
import { db } from '../src/utils/database/wrapper.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

const guild='123456789012345678',channel='234567890123456789',owner='345678901234567890',other='456789012345678901';
test('ticket feedback enforces ticket owner, keeps comment, and reports failed writes',async()=>{
 const originals={initialized:db.initialized,get:db.get,set:db.set,reply:InteractionHelper.safeReply,edit:InteractionHelper.safeEditReply,defer:InteractionHelper.safeDefer};
 let stored={id:'42',userId:owner,status:'closed',feedback:{comment:'Excellent'}};let result,shown=false,fail=false;
 db.initialized=true;db.get=async()=>structuredClone(stored);db.set=async(k,v)=>{if(fail)return false;stored=structuredClone(v);return true};
 InteractionHelper.safeReply=async(i,v)=>{result=v};InteractionHelper.safeEditReply=async(i,v)=>{result=v};InteractionHelper.safeDefer=async()=>true;
 const client={guilds:{cache:new Map(),fetch:async()=>null}};
 const interaction=id=>({user:{id},client,deferUpdate:async()=>{},showModal:async()=>{shown=true},update:async v=>{result=v},fields:{getTextInputValue:()=> 'Good service'}});
 try{
  await buttons[1].execute(interaction(other),client,[guild,channel]);assert.match(result.content,/Only the ticket creator/);assert.equal(shown,false);
  await buttons[2].execute(interaction(other),client,[guild,channel]);assert.match(result.content,/Only the ticket creator/);
  await buttons[1].execute(interaction(owner),client,[guild,channel]);assert.equal(shown,true);
  await buttons[0].execute(interaction(owner),client,[guild,channel,'4']);assert.equal(stored.feedback.rating,4);assert.equal(stored.feedback.comment,'Excellent');
  fail=true;await modal.execute(interaction(owner),client,[guild,channel]);assert.match(result.content,/could not be saved/);assert.equal(stored.feedback.comment,'Excellent');
  fail=false;await modal.execute(interaction(owner),client,[guild,channel]);assert.equal(stored.feedback.comment,'Good service');assert.equal(stored.feedback.rating,4);
 }finally{Object.assign(db,{initialized:originals.initialized,get:originals.get,set:originals.set});Object.assign(InteractionHelper,{safeReply:originals.reply,safeEditReply:originals.edit,safeDefer:originals.defer});}
});
