___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Tagreeve tag reporter",
  "categories": ["UTILITY"],
  "description": "Reports which tags ran for each event, with their status, to a Tagreeve test run in the same browser. Sends no event data. Does nothing where the Tagreeve binding is absent.",
  "containerContexts": [
    "WEB"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "nameKey",
    "displayName": "Tag name metadata key",
    "simpleValueType": true,
    "defaultValue": "name",
    "help": "The key of the tag metadata that holds the tag name. Turn on \"Include tag name\" in each tag's Additional Tag Metadata with this key."
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const addEventCallback = require('addEventCallback');
const callInWindow = require('callInWindow');
const copyFromDataLayer = require('copyFromDataLayer');
const getContainerVersion = require('getContainerVersion');
const makeString = require('makeString');

const nameKey = data.nameKey || 'name';
const event = copyFromDataLayer('event');
const gtmUniqueEventId = copyFromDataLayer('gtm.uniqueEventId');
const rawVersion = getContainerVersion().version;
const version = rawVersion === undefined ? undefined : makeString(rawVersion);

addEventCallback(function(ctid, eventData) {
  const tags = (eventData && eventData.tags) || [];
  callInWindow('tagreeveTagReport', {
    v: 1,
    container: ctid,
    event: event,
    gtmUniqueEventId: gtmUniqueEventId,
    version: version,
    tags: tags.map(function(tag) {
      const name = tag[nameKey];
      return {
        id: makeString(tag.id),
        status: tag.status,
        executionTime: tag.executionTime,
        name: typeof name === 'string' ? name : null
      };
    })
  });
});

data.gtmOnSuccess();


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {"publicId": "read_event_metadata", "versionId": "1"},
      "param": []
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {"publicId": "access_globals", "versionId": "1"},
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  {"type": 1, "string": "key"},
                  {"type": 1, "string": "read"},
                  {"type": 1, "string": "write"},
                  {"type": 1, "string": "execute"}
                ],
                "mapValue": [
                  {"type": 1, "string": "tagreeveTagReport"},
                  {"type": 8, "boolean": false},
                  {"type": 8, "boolean": false},
                  {"type": 8, "boolean": true}
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {"isEditedByUser": true},
    "isRequired": true
  },
  {
    "instance": {
      "key": {"publicId": "read_data_layer", "versionId": "1"},
      "param": [
        {
          "key": "allowedKeys",
          "value": {"type": 1, "string": "specific"}
        },
        {
          "key": "keyPatterns",
          "value": {
            "type": 2,
            "listItem": [
              {"type": 1, "string": "event"},
              {"type": 1, "string": "gtm.uniqueEventId"}
            ]
          }
        }
      ]
    },
    "clientAnnotations": {"isEditedByUser": true},
    "isRequired": true
  },
  {
    "instance": {
      "key": {"publicId": "read_container_data", "versionId": "1"},
      "param": []
    },
    "isRequired": true
  }
]


___TESTS___

scenarios:
- name: Reports the tags of an event once and succeeds
  code: |-
    mock('copyFromDataLayer', (key) => key === 'event' ? 'purchase' : 7);
    mock('getContainerVersion', () => ({version: '3'}));
    mock('addEventCallback', (callback) => {
      callback('GTM-PWTEST1', {tags: [{id: '11', status: 'success', executionTime: 4, name: 'GA4 - Purchase'}]});
    });
    mock('callInWindow', (name, report) => {
      assertThat(name).isEqualTo('tagreeveTagReport');
      assertThat(report.tags[0].name).isEqualTo('GA4 - Purchase');
    });
    runCode({nameKey: 'name'});
    assertApi('callInWindow').wasCalled();
    assertApi('gtmOnSuccess').wasCalled();
- name: A tag without the name key is reported with a null name
  code: |-
    mock('addEventCallback', (callback) => {
      callback('GTM-PWTEST1', {tags: [{id: '12', status: 'failure', executionTime: 1}]});
    });
    mock('callInWindow', (name, report) => {
      assertThat(report.tags[0].name).isEqualTo(null);
    });
    runCode({nameKey: 'name'});
    assertApi('gtmOnSuccess').wasCalled();


___NOTES___

Created for Tagreeve test runs. It needs the "No additional consent required" setting and a Custom Event trigger on all events. Keep it in a workspace or an environment, not in a published version.
