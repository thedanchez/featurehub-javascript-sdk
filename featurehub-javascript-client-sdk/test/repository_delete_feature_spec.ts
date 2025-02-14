import {
  ClientFeatureRepository,
  FeatureState,
  FeatureValueType,
  SSEResultState
} from '../app';
import { expect } from 'chai';

describe('if a feature is deleted it becomes undefined', () => {
  let repo: ClientFeatureRepository;

  beforeEach(() => {
    repo = new ClientFeatureRepository();
  });

  it('should allow us to delete a feature', () => {
    const features = [
      { id: '1', key: 'banana', version: 1, type: FeatureValueType.Boolean, value: true } as FeatureState,
    ];

    repo.notify(SSEResultState.Features, features);
    expect(repo.feature('banana').flag).to.eq(true);
    expect(repo.getFlag('banana')).to.eq(true);
    expect(repo.feature('banana').exists).to.be.true;
    repo.notify(SSEResultState.DeleteFeature, features[0]);
    // tslint:disable-next-line:no-unused-expression
    expect(repo.feature('banana').exists).to.be.false;
    expect(repo.feature('banana').flag).to.undefined;
    // tslint:disable-next-line:no-unused-expression
    expect(repo.getFlag('banana')).to.undefined;
    // tslint:disable-next-line:no-unused-expression
    expect(repo.isSet('banana')).to.be.false;
    // tslint:disable-next-line:no-unused-expression
    expect(repo.feature('banana').isSet()).to.be.false;
  });

  it("if features are deleted from FH, on the next poll they won't turn up, so we should indicate they don't exist", () => {
    const features = [
      { id: '1', key: 'banana', version: 1, type: FeatureValueType.Boolean, value: true } as FeatureState,
    ];

    repo.notify(SSEResultState.Features, features);
    expect(repo.feature('banana').exists).to.be.true;
    repo.notify(SSEResultState.Features, []);
    expect(repo.feature('banana').exists).to.be.false;
  });

  it('should ignore deleting a feature that doesnt exist', () => {
    repo.notify(SSEResultState.DeleteFeature,

        { id: '1', key: 'banana', version: 1, type: FeatureValueType.Boolean, value: true } as FeatureState
    );

    // tslint:disable-next-line:no-unused-expression
    expect(repo.getFeatureState('banana').isSet()).to.be.false;
  });
});
