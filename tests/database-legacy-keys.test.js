import test from 'node:test';import assert from 'node:assert/strict';import {canonicalizeKey,getLegacyVariantsForCanonical} from '../src/utils/database/keys.js';
test('legacy aliases round-trip to canonical keys, including the notes list',()=>{
 const g='123456789012345678',u='234567890123456789',examples=[
  [`economy:${g}:${u}`,`guild:${g}:economy:${u}`],[`birthdays:${g}`,`guild:${g}:birthdays`],[`${g}:leveling:users:${u}`,`guild:${g}:leveling:users:${u}`],
  [`moderation:warnings:${g}:${u}`,`guild:${g}:warnings:${u}`],[`moderation_user_notes_${g}_${u}`,`guild:${g}:usernotes:${u}`],[`moderation_user_notes_list_${g}`,`guild:${g}:usernotes:list`],
  [`moderation_user_notes_${g}_list`,`guild:${g}:usernotes:list`],[`reaction_roles:${g}:${u}`,`guild:${g}:reaction_roles:${u}`],[`counters:${g}`,`guild:${g}:counters`],[`bday-role-tracking-${g}`,`guild:${g}:birthdays:tracking`]];
 for(const [legacy,canonical] of examples){assert.equal(canonicalizeKey(legacy),canonical,legacy);assert.ok(getLegacyVariantsForCanonical(canonical).includes(legacy),canonical)}
});
