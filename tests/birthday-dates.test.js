import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LEAP_DAY_FALLBACK,
    isBirthdayOn,
    isLeapYear,
    nextBirthday,
    observedBirthday,
    validBirthday,
} from '../src/utils/birthdayDates.js';
import { validBirthday as storageValidBirthday } from '../src/services/storage/sqliteBirthdays.js';

const utc = (year, month, day, hour = 12) => new Date(Date.UTC(year, month - 1, day, hour));
const leapDay = { month: 2, day: 29 };

test('a birthday is valid when the date exists in some year', () => {
    assert.equal(validBirthday(2, 29), true);
    assert.equal(validBirthday(12, 31), true);
    for (const [month, day] of [[2, 30], [4, 31], [0, 1], [13, 1], [1, 0], [1, 32], ['2', 1], [2, 1.5]]) {
        assert.equal(validBirthday(month, day), false, `${month}/${day}`);
    }
    assert.equal(storageValidBirthday, validBirthday, 'storage and commands share one rule');
});

test('leap years follow the Gregorian rule', () => {
    assert.deepEqual([2024, 2028, 2000].map(isLeapYear), [true, true, true]);
    assert.deepEqual([2026, 2027, 2100, 1900].map(isLeapYear), [false, false, false, false]);
});

test('29 February is observed on the fallback day only in years without it', () => {
    assert.deepEqual(LEAP_DAY_FALLBACK, { month: 2, day: 28 });
    assert.deepEqual(observedBirthday(leapDay, 2027), { month: 2, day: 28 });
    assert.deepEqual(observedBirthday(leapDay, 2028), { month: 2, day: 29 });
    assert.deepEqual(observedBirthday({ month: 2, day: 28 }, 2027), { month: 2, day: 28 });

    // Non-leap year: once, on 28 February.
    assert.equal(isBirthdayOn(leapDay, utc(2027, 2, 27)), false);
    assert.equal(isBirthdayOn(leapDay, utc(2027, 2, 28)), true);
    assert.equal(isBirthdayOn(leapDay, utc(2027, 3, 1)), false);
    // Leap year: once, on 29 February, and not also on the 28th.
    assert.equal(isBirthdayOn(leapDay, utc(2028, 2, 28)), false);
    assert.equal(isBirthdayOn(leapDay, utc(2028, 2, 29)), true);
    assert.equal(isBirthdayOn(leapDay, utc(2028, 3, 1)), false);
});

test('each birthday is observed on exactly one day of every year', () => {
    for (const year of [2027, 2028]) {
        for (const birthday of [leapDay, { month: 2, day: 28 }, { month: 3, day: 1 }, { month: 12, day: 31 }]) {
            let hits = 0;
            for (let time = Date.UTC(year, 0, 1); time < Date.UTC(year + 1, 0, 1); time += 86_400_000) {
                if (isBirthdayOn(birthday, new Date(time))) hits++;
            }
            assert.equal(hits, 1, `${birthday.month}/${birthday.day} in ${year}`);
        }
    }
});

test('today is decided by the UTC date, at any hour', () => {
    const birthday = { month: 11, day: 13 };
    assert.equal(isBirthdayOn(birthday, new Date('2026-11-13T00:00:00Z')), true);
    assert.equal(isBirthdayOn(birthday, new Date('2026-11-13T23:59:59Z')), true);
    assert.equal(isBirthdayOn(birthday, new Date('2026-11-14T00:00:00Z')), false);
    assert.equal(isBirthdayOn({ month: 2, day: 30 }, utc(2027, 3, 2)), false);
    assert.equal(isBirthdayOn(null, utc(2027, 3, 2)), false);
});

test('next birthday counts whole UTC days and agrees with "today"', () => {
    assert.equal(nextBirthday({ month: 11, day: 13 }, utc(2026, 11, 13, 23)).daysUntil, 0);
    assert.equal(nextBirthday({ month: 11, day: 14 }, utc(2026, 11, 13, 23)).daysUntil, 1);
    assert.equal(nextBirthday({ month: 11, day: 12 }, utc(2026, 11, 13)).daysUntil, 364);
    assert.equal(nextBirthday({ month: 1, day: 1 }, utc(2026, 12, 31)).daysUntil, 1);

    const inNonLeapYear = nextBirthday(leapDay, utc(2027, 2, 27));
    assert.equal(inNonLeapYear.daysUntil, 1);
    assert.equal(inNonLeapYear.date.toISOString(), '2027-02-28T00:00:00.000Z');

    // The day after the 2027 celebration, the next one is the real date in 2028.
    const afterFallback = nextBirthday(leapDay, utc(2027, 3, 1));
    assert.equal(afterFallback.date.toISOString(), '2028-02-29T00:00:00.000Z');
    assert.equal(afterFallback.daysUntil, 365);

    for (const now of [utc(2027, 2, 28), utc(2028, 2, 28), utc(2028, 2, 29), utc(2026, 11, 13)]) {
        for (const birthday of [leapDay, { month: 2, day: 28 }, { month: 11, day: 13 }]) {
            assert.equal(nextBirthday(birthday, now).daysUntil === 0, isBirthdayOn(birthday, now));
        }
    }
});
