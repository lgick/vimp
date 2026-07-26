import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// VoteView — синглтон, перезагружаем модуль для изоляции
let VoteView;

const elems = {
  voteId: 'vote',
  titleClass: 'vote-title',
  listClass: 'vote-list',
  navClass: 'vote-nav',
  navActiveClass: 'active',
};

const makeModel = () => ({ publisher: new Publisher() });

const voteData = (overrides = {}) => ({
  title: 'Сменить карту?',
  list: ['1. map_a', '2. map_b'],
  back: true,
  more: false,
  time: null,
  ...overrides,
});

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '';
  VoteView = (await import('../../packages/engine/src/client/components/view/Vote.js')).default;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoteView.createVote', () => {
  it('строит окно голосования с заголовком и списком', () => {
    const view = new VoteView(makeModel(), elems);

    view.createVote(voteData());

    const vote = document.getElementById('vote');
    expect(vote).not.toBeNull();
    expect(vote.querySelector('.vote-title').textContent).toBe('Сменить карту?');
    expect(vote.querySelectorAll('.vote-list li').length).toBe(2);
  });

  it('подсвечивает back и не подсвечивает more', () => {
    const view = new VoteView(makeModel(), elems);

    view.createVote(voteData({ back: true, more: false }));

    const nav = document.querySelector('.vote-nav');
    const [backElem, moreElem] = nav.children;
    expect(backElem.className).toBe('active');
    expect(moreElem.className).toBe('');
  });

  it('без времени эмитит timer с null', () => {
    const view = new VoteView(makeModel(), elems);
    const timers = [];
    view.publisher.on('timer', t => timers.push(t));

    view.createVote(voteData({ time: null }));

    expect(timers).toEqual([null]);
  });

  it('со временем удаляет окно и эмитит clear по истечении', () => {
    const view = new VoteView(makeModel(), elems);
    const clearSpy = vi.fn();
    view.publisher.on('clear', clearSpy);

    view.createVote(voteData({ time: 5000 }));
    expect(document.getElementById('vote')).not.toBeNull();

    vi.advanceTimersByTime(5000);
    expect(document.getElementById('vote')).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('VoteView.removeVote', () => {
  it('удаляет окно голосования из DOM', () => {
    const view = new VoteView(makeModel(), elems);
    view.createVote(voteData());

    view.removeVote(null);

    expect(document.getElementById('vote')).toBeNull();
  });

  it('срабатывает по событию clear модели', () => {
    const model = makeModel();
    const view = new VoteView(model, elems);
    view.createVote(voteData());

    model.publisher.emit('clear', null);

    expect(document.getElementById('vote')).toBeNull();
  });
});
