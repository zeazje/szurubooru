'use strict';

const api = require('../api.js');
const tags = require('../tags.js');
const misc = require('../util/misc.js');
const uri = require('../util/uri.js');
const settings = require('../models/settings.js');
const events = require('../events.js');
const views = require('../util/views.js');
const TagAutoCompleteControl = require('./tag_auto_complete_control.js');

const KEY_SPACE = 32;
const KEY_RETURN = 13;

const SOURCE_INIT = 'init';
const SOURCE_IMPLICATION = 'implication';
const SOURCE_USER_INPUT = 'user-input';
const SOURCE_SUGGESTION = 'suggestions';
const SOURCE_CLIPBOARD = 'clipboard';

const template = views.getTemplate('tag-input');

function _fadeOutListItemNodeStatus(listItemNode) {
    if (listItemNode.classList.length) {
        if (listItemNode.fadeTimeout) {
            window.clearTimeout(listItemNode.fadeTimeout);
        }
        listItemNode.fadeTimeout = window.setTimeout(() => {
            while (listItemNode.classList.length) {
                listItemNode.classList.remove(
                    listItemNode.classList.item(0));
            }
            listItemNode.fadeTimeout = null;
        }, 2500);
    }
}

class SuggestionList {
    constructor() {
        this._suggestions = {};
        this._banned = [];
    }

    clear() {
        this._suggestions = {};
    }

    get length() {
        return Object.keys(this._suggestions).length;
    }

    set(suggestion, weight) {
        if (this._suggestions.hasOwnProperty(suggestion)) {
            weight = Math.max(weight, this._suggestions[suggestion]);
        }
        this._suggestions[suggestion] = weight;
    }

    ban(suggestion) {
        this._banned.push(suggestion);
    }

    getAll() {
        let tuples = [];
        for (let suggestion of Object.keys(this._suggestions)) {
            if (!this._banned.includes(suggestion)) {
                const weight = this._suggestions[suggestion];
                tuples.push([suggestion, weight.toFixed(1)]);
            }
        }
        tuples.sort((a, b) => {
            let weightDiff = b[1] - a[1];
            let nameDiff = a[0].localeCompare(b[0]);
            return weightDiff == 0 ? nameDiff : weightDiff;
        });
        return tuples.map(tuple => {
            return {tagName: tuple[0], weight: tuple[1]};
        });
    }
}

class TagInputControl extends events.EventTarget {
    constructor(hostNode) {
        super();
        this.tags = [];
        this._hostNode = hostNode;
        this._suggestions = new SuggestionList();

        // dom
        const editAreaNode = template();
        this._editAreaNode = editAreaNode;
        this._tagInputNode = editAreaNode.querySelector('input');
        this._suggestionsNode = editAreaNode.querySelector('.tag-suggestions');
        this._tagListNode = editAreaNode.querySelector('ul.compact-tags');

        this._autoCompleteControl = new TagAutoCompleteControl(
            this._tagInputNode, {
                getTextToFind: () => {
                    return this._tagInputNode.value;
                },
                confirm: text => {
                    this._tagInputNode.value = '';
                    this.addTag(text, SOURCE_USER_INPUT);
                },
                delete: text => {
                    this._tagInputNode.value = '';
                    this.deleteTag(text);
                },
                verticalShift: -2,
                isTaggedWith: tagName => this.isTaggedWith(tagName),
            });

        // dom events
        this._tagInputNode.addEventListener(
            'keydown', e => this._evtInputKeyDown(e));
        this._tagInputNode.addEventListener(
            'paste', e => this._evtInputPaste(e));
        this._editAreaNode.querySelector('a.opacity').addEventListener(
            'click', e => this._evtToggleSuggestionsPopupOpacityClick(e));
        this._editAreaNode.querySelector('a.close').addEventListener(
            'click', e => this._evtCloseSuggestionsPopupClick(e));
        this._editAreaNode.querySelector('button').addEventListener(
            'click', e => this._evtAddTagButtonClick(e));

        // show
        this._hostNode.style.display = 'none';
        this._hostNode.parentNode.insertBefore(
            this._editAreaNode, hostNode.nextSibling);

        this.addEventListener('change', e => this._evtTagsChanged(e));
        this.addEventListener('add', e => this._evtTagAdded(e));
        this.addEventListener('remove', e => this._evtTagRemoved(e));

        // add existing tags
        this.addMultipleTags(this._hostNode.value, SOURCE_INIT);
    }

    isTaggedWith(tagName) {
        let actualTag = null;
        [tagName, actualTag] = this._transformTagName(tagName);
        return this.tags
            .map(t => t.toLowerCase())
            .includes(tagName.toLowerCase());
    }

    addMultipleTags(text, source) {
        for (let tagName of text.split(/\s+/).filter(word => word).reverse()) {
            this.addTag(tagName, source);
        }
    }

    addTag(tagName, source) {
        tagName = tags.getOriginalTagName(tagName);

        if (!tagName) {
            return;
        }

        let actualTag = null;
        [tagName, actualTag] = this._transformTagName(tagName);
        if (!this.isTaggedWith(tagName)) {
            this.tags.push(tagName);
        }
        this.dispatchEvent(new CustomEvent('add', {
            detail: {
                tagName: tagName,
                source: source,
            },
        }));
        this.dispatchEvent(new CustomEvent('change'));

        // XXX: perhaps we should aggregate suggestions from all implications
        // for call to the _suggestRelations
        if (source !== SOURCE_INIT && source !== SOURCE_CLIPBOARD) {
            for (let otherTagName of tags.getAllImplications(tagName)) {
                this.addTag(otherTagName, SOURCE_IMPLICATION);
            }
        }
    }

    deleteTag(tagName) {
        if (!tagName) {
            return;
        }
        let actualTag = null;
        [tagName, actualTag] = this._transformTagName(tagName);
        if (!this.isTaggedWith(tagName)) {
            return;
        }
        this._hideAutoComplete();
        this.tags = this.tags.filter(
            t => t.toLowerCase() != tagName.toLowerCase());
        this.dispatchEvent(new CustomEvent('remove', {
            detail: {
                tagName: tagName,
            },
        }));
        this.dispatchEvent(new CustomEvent('change'));
    }

    _evtTagsChanged(e) {
        this._hostNode.value = this.tags.join(' ');
        this._hostNode.dispatchEvent(new CustomEvent('change'));
    }

    _evtTagAdded(e) {
        const tagName = e.detail.tagName;
        const actualTag = tags.getTagByName(tagName);
        let listItemNode = this._getListItemNodeFromTagName(tagName);
        const alreadyAdded = !!listItemNode;
        if (alreadyAdded) {
            if (e.detail.source !== SOURCE_IMPLICATION) {
                listItemNode.classList.add('duplicate');
            }
        } else {
            listItemNode = this._createListItemNode(tagName);
            if (!actualTag) {
                listItemNode.classList.add('new');
            }
            if (e.detail.source === SOURCE_IMPLICATION) {
                listItemNode.classList.add('implication');
            }
            this._tagListNode.prependChild(listItemNode);
        }
        _fadeOutListItemNodeStatus(listItemNode);

        if ([SOURCE_USER_INPUT, SOURCE_SUGGESTION].includes(e.detail.source) &&
                actualTag) {
            this._loadSuggestions(actualTag);
        }
    }

    _evtTagRemoved(e) {
        const listItemNode = this._getListItemNodeFromTagName(e.detail.tagName);
        if (listItemNode) {
            listItemNode.parentNode.removeChild(listItemNode);
        }
    }

    _evtInputPaste(e) {
        e.preventDefault();
        const pastedText = window.clipboardData ?
            window.clipboardData.getData('Text') :
            (e.originalEvent || e).clipboardData.getData('text/plain');

        if (pastedText.length > 2000) {
            window.alert('Pasted text is too long.');
            return;
        }
        this._hideAutoComplete();
        this.addMultipleTags(pastedText, SOURCE_CLIPBOARD);
        this._tagInputNode.value = '';
    }

    _evtCloseSuggestionsPopupClick(e) {
        e.preventDefault();
        this._closeSuggestionsPopup();
    }

    _evtAddTagButtonClick(e) {
        e.preventDefault();
        this.addTag(this._tagInputNode.value, SOURCE_USER_INPUT);
        this._tagInputNode.value = '';
    }

    _evtToggleSuggestionsPopupOpacityClick(e) {
        e.preventDefault();
        this._toggleSuggestionsPopupOpacity();
    }

    _evtInputKeyDown(e) {
        if (e.which == KEY_RETURN || e.which == KEY_SPACE) {
            e.preventDefault();
            this._hideAutoComplete();
            this.addMultipleTags(this._tagInputNode.value, SOURCE_USER_INPUT);
            this._tagInputNode.value = '';
        }
    }

    _transformTagName(tagName) {
        const actualTag = tags.getTagByName(tagName);
        if (actualTag) {
            tagName = actualTag.names[0];
        }
        return [tagName, actualTag];
    }

    _getListItemNodeFromTagName(tagName) {
        let actualTag = null;
        [tagName, actualTag] = this._transformTagName(tagName);
        for (let listItemNode of this._tagListNode.querySelectorAll('li')) {
            if (listItemNode.getAttribute('data-tag').toLowerCase() ===
                    tagName.toLowerCase()) {
                return listItemNode;
            }
        }
        return null;
    }

    _createListItemNode(tagName) {
        let actualTag = null;
        [tagName, actualTag] = this._transformTagName(tagName);
        const className = actualTag ?
            misc.makeCssName(actualTag.category, 'tag') :
            null;

        const tagLinkNode = document.createElement('a');
        if (className) {
            tagLinkNode.classList.add(className);
        }
        tagLinkNode.setAttribute(
            'href', uri.formatClientLink('tag', tagName));
        const tagIconNode = document.createElement('i');
        tagIconNode.classList.add('fa');
        tagIconNode.classList.add('fa-tag');
        tagLinkNode.appendChild(tagIconNode);

        const searchLinkNode = document.createElement('a');
        if (className) {
            searchLinkNode.classList.add(className);
        }
        searchLinkNode.setAttribute(
            'href', uri.formatClientLink('posts', {query: tagName}));
        searchLinkNode.textContent = tagName + ' ';
        searchLinkNode.addEventListener('click', e => {
            e.preventDefault();
            if (actualTag) {
                this._suggestions.clear();
                this._loadSuggestions(actualTag);
                this._removeSuggestionsPopupOpacity();
            } else {
                this._closeSuggestionsPopup();
            }
        });

        const usagesNode = document.createElement('span');
        usagesNode.classList.add('tag-usages');
        usagesNode.setAttribute(
            'data-pseudo-content', actualTag ? actualTag.usages : 0);

        const removalLinkNode = document.createElement('a');
        removalLinkNode.classList.add('remove-tag');
        removalLinkNode.setAttribute('href', '');
        removalLinkNode.setAttribute('data-pseudo-content', '×');
        removalLinkNode.addEventListener('click', e => {
            e.preventDefault();
            this.deleteTag(tagName);
        });

        const listItemNode = document.createElement('li');
        listItemNode.setAttribute('data-tag', tagName);
        listItemNode.appendChild(removalLinkNode);
        listItemNode.appendChild(tagLinkNode);
        listItemNode.appendChild(searchLinkNode);
        listItemNode.appendChild(usagesNode);
        return listItemNode;
    }

    _loadSuggestions(tag) {
        const browsingSettings = settings.get();
        if (!browsingSettings.tagSuggestions) {
            return;
        }
        api.get(
                uri.formatApiLink('tag-siblings', tag.names[0]),
                {noProgress: true})
            .then(response => {
                return Promise.resolve(response.results);
            }, response => {
                return Promise.resolve([]);
            }).then(siblings => {
                const args = siblings.map(s => s.occurrences);
                let maxSiblingOccurrences = Math.max(1, ...args);
                for (let sibling of siblings) {
                    this._suggestions.set(
                        sibling.tag.names[0],
                        sibling.occurrences * 4.9 / maxSiblingOccurrences);
                }
                for (let suggestion of tag.suggestions || []) {
                    this._suggestions.set(suggestion, 5);
                }
                if (this._suggestions.length) {
                    this._openSuggestionsPopup();
                } else {
                    this._closeSuggestionsPopup();
                }
            });
    }

    _refreshSuggestionsPopup() {
        if (!this._suggestionsNode.classList.contains('shown')) {
            return;
        }
        const listNode = this._suggestionsNode.querySelector('ul');
        listNode.scrollTop = 0;
        while (listNode.firstChild) {
            listNode.removeChild(listNode.firstChild);
        }
        for (let tuple of this._suggestions.getAll()) {
            const tagName = tuple.tagName;
            const weight = tuple.weight;
            if (this.isTaggedWith(tagName)) {
                continue;
            }

            const actualTag = tags.getTagByName(tagName);
            const addLinkNode = document.createElement('a');
            addLinkNode.textContent = tagName;
            addLinkNode.classList.add('add-tag');
            addLinkNode.setAttribute('href', '');
            if (actualTag) {
                addLinkNode.classList.add(
                    misc.makeCssName(actualTag.category, 'tag'));
            }
            addLinkNode.addEventListener('click', e => {
                e.preventDefault();
                listNode.removeChild(listItemNode);
                this.addTag(tagName, SOURCE_SUGGESTION);
            });

            const weightNode = document.createElement('span');
            weightNode.classList.add('tag-weight');
            weightNode.setAttribute('data-pseudo-content', weight);

            const removalLinkNode = document.createElement('a');
            removalLinkNode.classList.add('remove-tag');
            removalLinkNode.setAttribute('href', '');
            removalLinkNode.setAttribute('data-pseudo-content', '×');
            removalLinkNode.addEventListener('click', e => {
                e.preventDefault();
                listNode.removeChild(listItemNode);
                this._suggestions.ban(tagName);
            });

            const listItemNode = document.createElement('li');
            listItemNode.appendChild(removalLinkNode);
            listItemNode.appendChild(weightNode);
            listItemNode.appendChild(addLinkNode);
            listNode.appendChild(listItemNode);
        }
    }

    _closeSuggestionsPopup() {
        this._suggestions.clear();
        this._suggestionsNode.classList.remove('shown');
    }

    _removeSuggestionsPopupOpacity() {
        this._suggestionsNode.classList.remove('translucent');
    }

    _toggleSuggestionsPopupOpacity() {
        this._suggestionsNode.classList.toggle('translucent');
    }

    _openSuggestionsPopup() {
        this._suggestionsNode.classList.add('shown');
        this._refreshSuggestionsPopup();
    }

    _hideAutoComplete() {
        this._autoCompleteControl.hide();
    }
}

module.exports = TagInputControl;
