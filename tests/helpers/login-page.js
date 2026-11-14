// What the pages shown before the dashboard opens (src/dashboard/loginPage.js) say, read the way
// a person reads them: the text, not the markup around it.
import assert from 'node:assert/strict';

const unescape = (html) => html.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

/** The message of a notice page; fails when the response is not such a page. */
export async function noticeText(response) {
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    const html = await response.text();
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    const notes = [...html.matchAll(/<p class="note" role="alert">(.*?)<\/p>/g)];
    assert.equal(notes.length, 1, 'one message on the page');
    return unescape(notes[0][1]);
}

/** The same for a page already read as text. */
export function noticeTextOf(html) {
    const notes = [...html.matchAll(/<p class="note" role="alert">(.*?)<\/p>/g)];
    assert.equal(notes.length, 1, 'one message on the page');
    return unescape(notes[0][1]);
}
