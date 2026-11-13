/**
 * Birthday calendar rules, in one place.
 *
 * A birthday is a month and a day without a year. Every "is it today?"
 * decision uses the UTC calendar date, so the result does not depend on the
 * timezone of the machine the bot runs on.
 */

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAY_MS = 86_400_000;

/**
 * 29 February can always be stored. In a year without that date the
 * birthday is observed on this day instead. Change it here (for example to
 * 1 March) and announcements, "today" and "upcoming" all follow.
 */
export const LEAP_DAY_FALLBACK = Object.freeze({ month: 2, day: 28 });

/** True for any date that exists in some year, including 29 February. */
export function validBirthday(month, day) {
    return Number.isInteger(month) && Number.isInteger(day)
        && month >= 1 && month <= 12
        && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

export const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const isLeapDay = (birthday) => birthday?.month === 2 && birthday?.day === 29;

/** The date on which `birthday` is celebrated in `year`. */
export function observedBirthday(birthday, year) {
    if (isLeapDay(birthday) && !isLeapYear(year)) return { ...LEAP_DAY_FALLBACK };
    return { month: birthday.month, day: birthday.day };
}

/** Is `birthday` celebrated on the UTC date of `now`? */
export function isBirthdayOn(birthday, now = new Date()) {
    if (!validBirthday(birthday?.month, birthday?.day)) return false;
    const observed = observedBirthday(birthday, now.getUTCFullYear());
    return observed.month === now.getUTCMonth() + 1 && observed.day === now.getUTCDate();
}

/**
 * Next celebration on or after the UTC date of `now`.
 * `daysUntil` is 0 on the day itself.
 */
export function nextBirthday(birthday, now = new Date()) {
    const year = now.getUTCFullYear();
    const today = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
    const at = (candidateYear) => {
        const observed = observedBirthday(birthday, candidateYear);
        return Date.UTC(candidateYear, observed.month - 1, observed.day);
    };
    let time = at(year);
    if (time < today) time = at(year + 1);
    return { date: new Date(time), daysUntil: Math.round((time - today) / DAY_MS) };
}
