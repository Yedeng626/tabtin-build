"""邮箱定向邀请（已注册用户）：email → user 解析，落库 email 类型并保留展示邮箱。

对照 tests/test_invitation_phone.py：同一 create_direct_invitation 链路，
仅解析入口与展示列不同。
"""
import pytest
from django.contrib.auth import get_user_model
from django.db import connections
from django.http import HttpRequest

from apps.tabtinspace.models import Organization, OrganizationInvitation, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.invitation_service import InvitationService
from apps.tabtinspace.routers.invitation import list_invitations

User = get_user_model()

OWNER_EMAIL = 'owner633e@tabtin.test'
MEMBER_A_EMAIL = 'membera633e@tabtin.test'
MEMBER_B_EMAIL = 'memberb633e@tabtin.test'


_DB_MARK = pytest.mark.django_db(databases=['default', 'postgresql'])


@pytest.fixture(autouse=True)
def _mute_default_organization_signal():
    from django.db.models.signals import post_save
    from apps.tabtinspace.signals import create_default_organization

    post_save.disconnect(create_default_organization, sender=User)
    try:
        yield
    finally:
        post_save.connect(create_default_organization, sender=User)


@pytest.fixture
def invite_ctx():
    owner = User.objects.create_user(email=OWNER_EMAIL, password='x', nickname='owner633e')
    member_a = User.objects.create_user(email=MEMBER_A_EMAIL, password='x', nickname='memberA633e')
    member_b = User.objects.create_user(email=MEMBER_B_EMAIL, password='x', nickname='memberB633e')
    if connections['postgresql'].settings_dict.get('TEST', {}).get('MIRROR') != 'default':
        User.objects.using('postgresql').bulk_create([owner, member_a, member_b])
    organization = Organization.objects.create(name='email invite 团队', owner=owner, type='team')
    return owner, member_a, member_b, organization


@_DB_MARK
class TestEmailTargetedInvitation:
    def test_email_invite_accept_full_flow(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx

        inv = InvitationService(user=owner).create_email_invitation_for_user(
            organization_id=organization.id, email=MEMBER_A_EMAIL, role='editor',
        )
        assert inv.invite_type == 'email'
        assert inv.email == MEMBER_A_EMAIL
        assert inv.invited_user_id == str(member_a.id)
        assert inv.status == 'pending'

        result = InvitationService(user=member_a).respond_to_invitation(inv.id, accept=True)
        assert result['organization_id'] == str(organization.id)
        member = OrganizationMember.objects.get(organization=organization, user_id=str(member_a.id))
        assert member.role == 'editor'

    def test_email_lookup_case_and_space_insensitive(self, invite_ctx):
        """大小写 + 前后空格都要命中同一个已注册用户。"""
        owner, member_a, _, organization = invite_ctx
        inv = InvitationService(user=owner).create_email_invitation_for_user(
            organization_id=organization.id, email='  %s  ' % MEMBER_A_EMAIL.upper(), role='editor',
        )
        assert inv.invited_user_id == str(member_a.id)

    def test_unregistered_email_rejected(self, invite_ctx):
        owner, _, _, organization = invite_ctx
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_email_invitation_for_user(
                organization_id=organization.id, email='nobody-633e@tabtin.test', role='editor',
            )
        assert exc.value.code == 'USER_NOT_FOUND_BY_EMAIL'

    def test_invalid_email_rejected(self, invite_ctx):
        owner, _, _, organization = invite_ctx
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_email_invitation_for_user(
                organization_id=organization.id, email='not-an-email', role='editor',
            )
        assert exc.value.code == 'INVALID_EMAIL'

    def test_email_invite_existing_member_rejected(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx
        OrganizationMember.objects.create(organization=organization, user_id=str(member_a.id), role='viewer')
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_email_invitation_for_user(
                organization_id=organization.id, email=MEMBER_A_EMAIL, role='editor',
            )
        assert exc.value.code == 'ALREADY_MEMBER'

    def test_repeat_email_invite_reuses_pending_invitation(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx
        svc = InvitationService(user=owner)
        first = svc.create_email_invitation_for_user(organization_id=organization.id, email=MEMBER_A_EMAIL)
        second = svc.create_email_invitation_for_user(organization_id=organization.id, email=MEMBER_A_EMAIL)
        assert second.id == first.id
        assert OrganizationInvitation.objects.filter(
            organization=organization, invited_user_id=str(member_a.id), status='pending',
        ).count() == 1

    def test_token_email_invite_does_not_reuse_targeted_row(self, invite_ctx):
        """令牌式邮件邀请与定向邮箱邀请靠 invited_user_id 区分，不能互相顶掉。"""
        owner, member_a, _, organization = invite_ctx
        svc = InvitationService(user=owner)
        targeted = svc.create_email_invitation_for_user(
            organization_id=organization.id, email=MEMBER_A_EMAIL, role='editor',
        )
        token_inv = svc.create_email_invitation(
            organization_id=organization.id, email=MEMBER_A_EMAIL, role='editor',
        )
        assert token_inv.id != targeted.id
        assert token_inv.invited_user_id == ''

    def test_list_shows_targeted_email_invitation(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx
        InvitationService(user=owner).create_email_invitation_for_user(
            organization_id=organization.id, email=MEMBER_A_EMAIL, role='editor',
        )

        request = HttpRequest()
        request.auth = owner
        response = list_invitations(request, organization.id)

        assert response['data']['total'] == 1
        listed = response['data']['invitations'][0]
        assert listed['invite_type'] == 'email'
        assert listed['email'] == MEMBER_A_EMAIL
        assert listed['invited_user_id'] == str(member_a.id)
        assert listed['invited_user_nickname'] == 'memberA633e'

    def test_personal_organization_rejected(self, invite_ctx):
        owner, _, _, _ = invite_ctx
        personal = Organization.objects.create(name='个人', owner=owner, type='personal')
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_email_invitation_for_user(
                organization_id=personal.id, email=MEMBER_A_EMAIL, role='editor',
            )
        assert exc.value.code == 'PERSONAL_ORGANIZATION_NOT_ALLOWED'
